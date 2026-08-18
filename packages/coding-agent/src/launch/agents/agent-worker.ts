/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * Resident worker runtime (SPEC §8.1).
 *
 * One resident worker owns one live AgentSession and survives client detach: the
 * worker process is the persistence, and it keeps the session live so scheduled/
 * heartbeat/goal prompts fire with no client attached. It:
 *
 *  - authenticates to the supervisor over the private transport (token +
 *    generation fencing);
 *  - streams settled session messages + run-state as events (its own monotonic
 *    cursor, generation-tagged);
 *  - services C4 commands routed by the supervisor (prompt/steer/follow_up,
 *    attach snapshot, schedule/heartbeat/goal/autonomous, self-directed
 *    send_message delivery);
 *  - stops cleanly on a routed C4 `shutdown` (never a raw signal — graft risk #2),
 *    draining and releasing its session lease.
 *
 * The runtime is deliberately decoupled from process bootstrap: it takes a
 * {@link ResidentSession}, a {@link WorkerScheduling} facade, and a
 * {@link WorkerSideLink}. Production wires the real AgentSession + scheduler; the
 * worker test drives it with fakes so attach/detach and command routing run in
 * one process without a live model.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type {
	ActiveSessionId,
	AgentAutonomousSpec,
	AgentAutonomousView,
	AgentControlCommand,
	AgentControlCommandEnvelope,
	AgentControlEvent,
	AgentControlResult,
	AgentDeliveryMode,
	AgentEventCursor,
	AgentGoalSpec,
	AgentGoalView,
	AgentScheduledJobView,
	AgentScheduleSpec,
	AgentSessionSummary,
} from "./control-protocol";
import type { ResidentSession } from "./resident-session";
import type { BrokerToWorker, WorkerSideLink } from "./worker-transport";

/**
 * The scheduling surface the worker exposes over C4. Wraps the scheduled-job
 * store + scheduler + goal + autonomous controllers; returns C4 views so the
 * worker never leaks the on-disk shapes. Implemented for real in
 * `worker-scheduling.ts`; stubbed in tests.
 */
export interface WorkerScheduling {
	start(): void;
	stop(): void;
	addJob(spec: AgentScheduleSpec): AgentScheduledJobView;
	listJobs(includeInactive: boolean): AgentScheduledJobView[];
	cancelJob(jobId: string): boolean;
	setHeartbeat(schedule: string, instruction: string, deliveryMode?: AgentDeliveryMode): AgentScheduledJobView;
	pauseHeartbeat(): AgentScheduledJobView | undefined;
	resumeHeartbeat(): AgentScheduledJobView | undefined;
	clearHeartbeat(): void;
	setGoal(spec: AgentGoalSpec): AgentGoalView;
	goalStatus(): AgentGoalView;
	pauseGoal(): AgentGoalView;
	resumeGoal(): AgentGoalView;
	clearGoal(): AgentGoalView;
	autonomousOn(spec: AgentAutonomousSpec | undefined): AgentAutonomousView;
	autonomousOff(): AgentAutonomousView;
	autonomousStatus(): AgentAutonomousView;
}

export interface AgentWorkerOptions {
	link: WorkerSideLink;
	session: ResidentSession;
	scheduling: WorkerScheduling;
	entityName: string;
	cwd: string;
	token: string;
	generation: string;
	/** Invoked after a clean shutdown so the host can release the lease + exit. */
	onStopped?: () => void | Promise<void>;
	now?: () => number;
}

export class AgentWorker {
	readonly #link: WorkerSideLink;
	readonly #session: ResidentSession;
	readonly #scheduling: WorkerScheduling;
	readonly #entityName: string;
	readonly #cwd: string;
	readonly #token: string;
	readonly #generation: string;
	readonly #onStopped?: () => void | Promise<void>;
	readonly #now: () => number;
	readonly #unsubscribers: Array<() => void> = [];
	#cursorSeq = 0;
	#authGate = Promise.withResolvers<void>();
	#stopped = false;

	constructor(options: AgentWorkerOptions) {
		this.#link = options.link;
		this.#session = options.session;
		this.#scheduling = options.scheduling;
		this.#entityName = options.entityName;
		this.#cwd = options.cwd;
		this.#token = options.token;
		this.#generation = options.generation;
		this.#onStopped = options.onStopped;
		this.#now = options.now ?? Date.now;
	}

	/** Authenticate, wire event streaming + scheduling, and announce readiness. */
	async start(): Promise<void> {
		this.#link.onMessage(message => void this.#onMessage(message));
		this.#link.onClose(() => void this.#shutdown("link_closed", false));
		this.#link.send({
			type: "auth",
			token: this.#token,
			generation: this.#generation,
			activeSessionId: this.#session.activeSessionId,
			entityName: this.#entityName,
			cwd: this.#cwd,
		});
		this.#link.send({ type: "lifecycle", state: "starting" });
		await this.#authGate.promise;

		this.#unsubscribers.push(this.#session.onMessage(message => this.#emit({ kind: "message", message })));
		this.#unsubscribers.push(this.#session.onRunStateChange(busy => this.#emit({ kind: "status", busy })));
		this.#scheduling.start();
		this.#link.send({ type: "lifecycle", state: "ready" });
	}

	#nextCursor(): AgentEventCursor {
		this.#cursorSeq += 1;
		return { generation: this.#generation, sequence: this.#cursorSeq };
	}

	#emit(event: AgentControlEvent): void {
		if (this.#stopped) return;
		this.#link.send({ type: "event", event, cursor: this.#nextCursor() });
	}

	async #onMessage(message: BrokerToWorker): Promise<void> {
		switch (message.type) {
			case "auth_ok":
				this.#authGate.resolve();
				break;
			case "auth_reject":
				this.#authGate.reject(new Error(`worker auth rejected: ${message.reason}`));
				break;
			case "command": {
				const result = await this.#handleCommand(message.envelope);
				this.#link.send({ type: "result", commandId: message.envelope.id, result });
				break;
			}
			case "deliver_message":
				await this.#session.deliverMessage(message.from, message.text, message.mode);
				break;
			case "shutdown":
				await this.#shutdown(message.reason, true);
				break;
			case "attach":
			case "detach":
				// Attach/detach are modeled as commands routed by the supervisor; these
				// direct variants are reserved for future direct-link fast paths.
				break;
		}
	}

	async #handleCommand(envelope: AgentControlCommandEnvelope): Promise<AgentControlResult> {
		const command = envelope.command;
		try {
			return await this.#dispatch(command);
		} catch (error) {
			return {
				type: command.type,
				ok: false,
				error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
			};
		}
	}

	async #dispatch(command: AgentControlCommand): Promise<AgentControlResult> {
		switch (command.type) {
			case "prompt": {
				// A fresh turn must not block the control response on turn completion;
				// fire it and report acceptance. Errors surface on the event stream.
				if (this.#session.isStreaming()) {
					await this.#session.followUp(command.text);
				} else {
					void this.#session.prompt(command.text).catch(error =>
						logger.warn("resident prompt failed", {
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				}
				return { type: "prompt", ok: true, accepted: true };
			}
			case "steer":
				await this.#session.steer(command.text);
				return { type: "steer", ok: true, accepted: true };
			case "follow_up":
				await this.#session.followUp(command.text);
				return { type: "follow_up", ok: true, accepted: true };
			case "attach":
				return { type: "attach", ok: true, result: this.#buildAttachResult(command.id) };
			case "send_message": {
				const outcome = await this.#session.deliverMessage(
					command.from ?? "peer",
					command.text,
					command.mode ?? "auto",
				);
				return {
					type: "send_message",
					ok: true,
					receipt: { target: command.target, outcome, mode: command.mode ?? "auto" },
				};
			}
			case "schedule_add":
				return { type: "schedule_add", ok: true, job: this.#scheduling.addJob(command.spec) };
			case "schedule_list":
				return {
					type: "schedule_list",
					ok: true,
					jobs: this.#scheduling.listJobs(command.includeInactive ?? false),
				};
			case "schedule_cancel":
				return { type: "schedule_cancel", ok: true, cancelled: this.#scheduling.cancelJob(command.jobId) };
			case "heartbeat_set":
				return {
					type: "heartbeat_set",
					ok: true,
					job: this.#scheduling.setHeartbeat(command.schedule, command.instruction, command.deliveryMode),
				};
			case "heartbeat_pause":
				return { type: "heartbeat_pause", ok: true, job: this.#scheduling.pauseHeartbeat() };
			case "heartbeat_resume":
				return { type: "heartbeat_resume", ok: true, job: this.#scheduling.resumeHeartbeat() };
			case "heartbeat_clear":
				this.#scheduling.clearHeartbeat();
				return { type: "heartbeat_clear", ok: true };
			case "goal_set":
				return { type: "goal_set", ok: true, goal: this.#scheduling.setGoal(command.spec) };
			case "goal_status":
				return { type: "goal_status", ok: true, goal: this.#scheduling.goalStatus() };
			case "goal_pause":
				return { type: "goal_pause", ok: true, goal: this.#scheduling.pauseGoal() };
			case "goal_resume":
				return { type: "goal_resume", ok: true, goal: this.#scheduling.resumeGoal() };
			case "goal_clear":
				return { type: "goal_clear", ok: true, goal: this.#scheduling.clearGoal() };
			case "autonomous_on":
				return { type: "autonomous_on", ok: true, status: this.#scheduling.autonomousOn(command.spec) };
			case "autonomous_off":
				return { type: "autonomous_off", ok: true, status: this.#scheduling.autonomousOff() };
			case "autonomous_status":
				return { type: "autonomous_status", ok: true, status: this.#scheduling.autonomousStatus() };
			default:
				return {
					type: command.type,
					ok: false,
					error: { code: "invalid_command", message: `worker cannot handle ${command.type}` },
				};
		}
	}

	#buildAttachResult(id: ActiveSessionId) {
		const messages = this.#session.getMessages();
		const cursor: AgentEventCursor = { generation: this.#generation, sequence: this.#cursorSeq };
		const summary: AgentSessionSummary = {
			id,
			entityName: this.#entityName,
			cwd: this.#cwd,
			workerState: "ready",
			attached: true,
			busy: this.#session.isStreaming(),
			createdAt: new Date(this.#now()).toISOString(),
		};
		return {
			protocol: { name: "omp-agent.daemon" as const, version: 1 },
			activeSessionId: id,
			snapshot: {
				activeSessionId: id,
				entityName: this.#entityName,
				summary,
				messages,
				messageCount: messages.length,
				lastEventSequence: this.#cursorSeq,
				lastEventCursor: cursor,
				replay: { status: "complete" as const, toSequence: this.#cursorSeq },
			},
			replay: { status: "complete" as const, toSequence: this.#cursorSeq },
			client: { id: "", capabilities: [] },
		};
	}

	async #shutdown(reason: string, disposeSession: boolean): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#scheduling.stop();
		for (const unsubscribe of this.#unsubscribers) {
			try {
				unsubscribe();
			} catch {
				// listener teardown is best-effort
			}
		}
		if (disposeSession) {
			try {
				await this.#session.dispose(reason);
			} catch (error) {
				logger.warn("resident session dispose failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		// Release the session lease (onStopped) BEFORE closing the link: the
		// supervisor treats link-close as the drained signal, and an immediate
		// respawn must find the lease already free (see AgentSupervisor.#stop).
		await this.#onStopped?.();
		this.#link.close();
	}

	/** Test/host hook: request a clean stop as if the supervisor sent `shutdown`. */
	stop(reason = "host_stop"): Promise<void> {
		return this.#shutdown(reason, true);
	}
}
