/**
 * High-level C4 client (SPEC §12, CONTRACTS.md C4 consumers WS5/WS7).
 *
 * A thin, typed facade over the broker socket for driving resident agent
 * sessions: spawn/attach/detach/list/stop, prompt/steer/follow_up, peer
 * send_message, and the schedule/heartbeat/goal/autonomous surface. It hides the
 * command-envelope + `agent` DaemonOperation plumbing so the CLI/TUI (WS7) and
 * the peer layer (WS5) call plain methods and subscribe to session events.
 */

import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { DaemonBrokerClient } from "../client";
import {
	type ActiveSessionId,
	type AgentAttachResult,
	type AgentAutonomousSpec,
	type AgentAutonomousView,
	type AgentClientCapability,
	type AgentControlCommand,
	type AgentControlEventEnvelope,
	type AgentControlResult,
	type AgentDeliveryMode,
	type AgentEventCursor,
	type AgentGoalSpec,
	type AgentGoalView,
	type AgentMessageMode,
	type AgentMessageReceipt,
	type AgentScheduledJobView,
	type AgentScheduleSpec,
	type AgentSessionSummary,
	createAgentCommandEnvelope,
} from "./control-protocol";

function agentError(result: AgentControlResult): Error {
	if (result.ok === false) {
		const error = new Error(`${result.error.code}: ${result.error.message}`);
		error.name = "AgentControlError";
		return error;
	}
	return new Error(`unexpected agent result for ${result.type}`);
}

/** Broker filename holding `{ pid, instanceId }` for the scope's owning broker. */
const BROKER_PID_FILE = "broker.pid";
/** Poll cadence + ceilings for the daemon restart handshake. */
const BROKER_EXIT_POLL_MS = 100;
const BROKER_EXIT_TIMEOUT_MS = 8_000;
const BROKER_RESPAWN_ATTEMPTS = 40;

/** Outcome of {@link AgentDaemonClient.promptAndWait}. */
export interface EntityTurnResult {
	/** The last assistant message emitted during the woken turn, if any. */
	reply?: AgentMessage;
	/** Every assistant message emitted during the woken turn, in order. */
	messages: AgentMessage[];
	/** The session closed while waiting for the turn to complete. */
	closed: boolean;
	/** The wait ceiling elapsed before the turn ended. */
	timedOut: boolean;
}

/** Snapshot of the entity-runtime daemon (broker) for `entity daemon status`. */
export interface EntityDaemonStatus {
	running: boolean;
	pid?: number;
	runtimeDir: string;
	projectDir: string;
	sessions: AgentSessionSummary[];
}

/** Result of `entity daemon shutdown`. */
export interface EntityDaemonShutdown {
	stopped: boolean;
	wasRunning: boolean;
	hadSessions: number;
}

/** Result of `entity daemon restart`. */
export interface EntityDaemonRestart {
	restarted: boolean;
	previousPid?: number;
	previousSessions: number;
	pid?: number;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class AgentDaemonClient {
	readonly #broker: DaemonBrokerClient;
	readonly #clientId: string;

	constructor(broker: DaemonBrokerClient, clientId: string = crypto.randomUUID()) {
		this.#broker = broker;
		this.#clientId = clientId;
	}

	get clientId(): string {
		return this.#clientId;
	}

	/** Release the underlying broker socket so a one-shot caller can exit. */
	close(): void {
		this.#broker.close();
	}

	/**
	 * Send one raw command and return its typed result. `commandId` keys the
	 * broker's idempotency journal — reuse it on a retry to avoid re-running a
	 * mutation whose outcome you did not observe.
	 */
	async command(command: AgentControlCommand, commandId: string = crypto.randomUUID()): Promise<AgentControlResult> {
		const envelope = createAgentCommandEnvelope(command, commandId, this.#clientId);
		const result = await this.#broker.request({ op: "agent", envelope });
		if (result.op !== "agent") throw new Error(`broker returned ${result.op} for an agent command`);
		return result.response;
	}

	/** Subscribe to a session's event stream (messages/status/goal/etc.). */
	onEvent(id: ActiveSessionId, sink: (envelope: AgentControlEventEnvelope) => void): () => void {
		if (!this.#broker.onAgentEvent) throw new Error("broker does not support agent event streaming");
		return this.#broker.onAgentEvent(id, sink);
	}

	async spawn(entityName: string, cwd?: string, force?: boolean): Promise<AgentSessionSummary> {
		const result = await this.command({ type: "spawn", entityName, cwd, force });
		if (result.type === "spawn" && result.ok) return result.summary;
		throw agentError(result);
	}

	/**
	 * Prompt a resident session and block until the woken turn completes,
	 * returning the assistant messages it produced. Adapted from Prime's
	 * `promptAndWait`: attach so the event stream flows to this client, send the
	 * prompt, then resolve when the worker's run-state returns to idle (or the
	 * session closes / a ceiling elapses). The resident worker emits `status`
	 * busy=true → `message` events → `status` busy=false around the woken turn.
	 */
	async promptAndWait(
		id: ActiveSessionId,
		text: string,
		options: { timeoutMs?: number } = {},
	): Promise<EntityTurnResult> {
		const messages: AgentMessage[] = [];
		let sawBusy = false;
		let accepted = false;
		let closed = false;
		let timedOut = false;
		const done = Promise.withResolvers<void>();
		const unsubscribe = this.onEvent(id, envelope => {
			const event = envelope.event;
			if (event.kind === "status") {
				if (event.busy) sawBusy = true;
				else if (sawBusy || accepted) done.resolve();
			} else if (event.kind === "message") {
				if (event.message.role === "assistant") messages.push(event.message);
			} else if (event.kind === "closed") {
				closed = true;
				done.resolve();
			}
		});
		let timer: NodeJS.Timeout | undefined;
		try {
			await this.attach(id);
			await this.prompt(id, text);
			accepted = true;
			if (options.timeoutMs !== undefined) {
				timer = setTimeout(() => {
					timedOut = true;
					done.resolve();
				}, options.timeoutMs);
			}
			await done.promise;
		} finally {
			clearTimeout(timer);
			unsubscribe();
			if (!closed) {
				try {
					await this.detach(id);
				} catch {
					// Best-effort detach; the session may already be gone.
				}
			}
		}
		return { reply: messages.at(-1), messages, closed, timedOut };
	}

	async attach(
		id: ActiveSessionId,
		options: { capabilities?: AgentClientCapability[]; resume?: AgentEventCursor } = {},
	): Promise<AgentAttachResult> {
		const result = await this.command({
			type: "attach",
			id,
			capabilities: options.capabilities,
			resume: options.resume,
		});
		if (result.type === "attach" && result.ok) return result.result;
		throw agentError(result);
	}

	async detach(id: ActiveSessionId): Promise<void> {
		const result = await this.command({ type: "detach", id });
		if (!(result.type === "detach" && result.ok)) throw agentError(result);
	}

	async list(): Promise<AgentSessionSummary[]> {
		const result = await this.command({ type: "list" });
		if (result.type === "list" && result.ok) return result.sessions;
		throw agentError(result);
	}

	async stop(id: ActiveSessionId): Promise<void> {
		const result = await this.command({ type: "stop", id });
		if (!(result.type === "stop" && result.ok)) throw agentError(result);
	}

	async prompt(id: ActiveSessionId, text: string): Promise<void> {
		const result = await this.command({ type: "prompt", id, text });
		if (!(result.type === "prompt" && result.ok)) throw agentError(result);
	}

	async steer(id: ActiveSessionId, text: string): Promise<void> {
		const result = await this.command({ type: "steer", id, text });
		if (!(result.type === "steer" && result.ok)) throw agentError(result);
	}

	async followUp(id: ActiveSessionId, text: string): Promise<void> {
		const result = await this.command({ type: "follow_up", id, text });
		if (!(result.type === "follow_up" && result.ok)) throw agentError(result);
	}

	async sendMessage(
		target: string,
		text: string,
		mode: AgentMessageMode = "auto",
		from?: string,
	): Promise<AgentMessageReceipt> {
		const result = await this.command({ type: "send_message", target, text, mode, from });
		if (result.type === "send_message" && result.ok) return result.receipt;
		throw agentError(result);
	}

	async scheduleAdd(id: ActiveSessionId, spec: AgentScheduleSpec): Promise<AgentScheduledJobView> {
		const result = await this.command({ type: "schedule_add", id, spec });
		if (result.type === "schedule_add" && result.ok) return result.job;
		throw agentError(result);
	}

	async scheduleList(id: ActiveSessionId, includeInactive = false): Promise<AgentScheduledJobView[]> {
		const result = await this.command({ type: "schedule_list", id, includeInactive });
		if (result.type === "schedule_list" && result.ok) return result.jobs;
		throw agentError(result);
	}

	async scheduleCancel(id: ActiveSessionId, jobId: string): Promise<boolean> {
		const result = await this.command({ type: "schedule_cancel", id, jobId });
		if (result.type === "schedule_cancel" && result.ok) return result.cancelled;
		throw agentError(result);
	}

	async heartbeatSet(
		id: ActiveSessionId,
		schedule: string,
		instruction: string,
		deliveryMode?: AgentDeliveryMode,
	): Promise<AgentScheduledJobView | undefined> {
		const result = await this.command({ type: "heartbeat_set", id, schedule, instruction, deliveryMode });
		if (result.type === "heartbeat_set" && result.ok) return result.job;
		throw agentError(result);
	}

	async heartbeatPause(id: ActiveSessionId): Promise<void> {
		const result = await this.command({ type: "heartbeat_pause", id });
		if (!(result.type === "heartbeat_pause" && result.ok)) throw agentError(result);
	}

	async heartbeatResume(id: ActiveSessionId): Promise<void> {
		const result = await this.command({ type: "heartbeat_resume", id });
		if (!(result.type === "heartbeat_resume" && result.ok)) throw agentError(result);
	}

	async heartbeatClear(id: ActiveSessionId): Promise<void> {
		const result = await this.command({ type: "heartbeat_clear", id });
		if (!(result.type === "heartbeat_clear" && result.ok)) throw agentError(result);
	}

	async goalSet(id: ActiveSessionId, spec: AgentGoalSpec): Promise<AgentGoalView> {
		const result = await this.command({ type: "goal_set", id, spec });
		if (result.type === "goal_set" && result.ok) return result.goal;
		throw agentError(result);
	}

	async goalStatus(id: ActiveSessionId): Promise<AgentGoalView> {
		const result = await this.command({ type: "goal_status", id });
		if (result.type === "goal_status" && result.ok) return result.goal;
		throw agentError(result);
	}

	async goalPause(id: ActiveSessionId): Promise<AgentGoalView> {
		const result = await this.command({ type: "goal_pause", id });
		if (result.type === "goal_pause" && result.ok) return result.goal;
		throw agentError(result);
	}

	async goalResume(id: ActiveSessionId): Promise<AgentGoalView> {
		const result = await this.command({ type: "goal_resume", id });
		if (result.type === "goal_resume" && result.ok) return result.goal;
		throw agentError(result);
	}

	async goalClear(id: ActiveSessionId): Promise<AgentGoalView> {
		const result = await this.command({ type: "goal_clear", id });
		if (result.type === "goal_clear" && result.ok) return result.goal;
		throw agentError(result);
	}

	async autonomousOn(id: ActiveSessionId, spec?: AgentAutonomousSpec): Promise<AgentAutonomousView> {
		const result = await this.command({ type: "autonomous_on", id, spec });
		if (result.type === "autonomous_on" && result.ok) return result.status;
		throw agentError(result);
	}

	async autonomousOff(id: ActiveSessionId): Promise<AgentAutonomousView> {
		const result = await this.command({ type: "autonomous_off", id });
		if (result.type === "autonomous_off" && result.ok) return result.status;
		throw agentError(result);
	}

	async autonomousStatus(id: ActiveSessionId): Promise<AgentAutonomousView> {
		const result = await this.command({ type: "autonomous_status", id });
		if (result.type === "autonomous_status" && result.ok) return result.status;
		throw agentError(result);
	}

	// Daemon (broker) lifecycle -------------------------------------------------

	/**
	 * Report the entity-runtime broker's liveness + resident sessions WITHOUT
	 * spawning one: liveness is read from the on-disk `broker.pid`, and sessions
	 * are listed only when a broker is already alive (so this never resurrects a
	 * stopped daemon just to describe it).
	 */
	async daemonStatus(): Promise<EntityDaemonStatus> {
		const runtimeDir = this.#broker.runtimeDir;
		const projectDir = this.#broker.projectDir;
		const pid = runtimeDir === undefined ? undefined : await this.#readBrokerPid(runtimeDir);
		const running = pid !== undefined && isPidAlive(pid);
		let sessions: AgentSessionSummary[] = [];
		if (running) {
			try {
				sessions = await this.list();
			} catch {
				// The broker is exiting between the pid read and the list; treat as no sessions.
			}
		}
		return { running, pid: running ? pid : undefined, runtimeDir: runtimeDir ?? "", projectDir, sessions };
	}

	/**
	 * Stop the entity-runtime broker and all its resident workers. Refuses when
	 * sessions are live unless `force` is set; a no-op (with `wasRunning:false`)
	 * when no broker is running.
	 */
	async daemonShutdown(force = false): Promise<EntityDaemonShutdown> {
		const status = await this.daemonStatus();
		if (!status.running) return { stopped: false, wasRunning: false, hadSessions: 0 };
		if (status.sessions.length > 0 && !force) {
			const n = status.sessions.length;
			throw new Error(
				`${n} entit${n === 1 ? "y is" : "ies are"} live; stop them first or pass --force to shut the daemon down anyway`,
			);
		}
		await this.#broker.request({ op: "shutdown" });
		return { stopped: true, wasRunning: true, hadSessions: status.sessions.length };
	}

	/**
	 * Cleanly cycle the broker: shut the current one (and its resident workers)
	 * down, wait for it to exit and release its lease, then respawn a FRESH
	 * broker and confirm it answers. This is the fix for a stale model alias
	 * pinned in a long-lived resident broker — the new broker reloads config.
	 */
	async daemonRestart(): Promise<EntityDaemonRestart> {
		const before = await this.daemonStatus();
		if (before.running) {
			await this.#broker.request({ op: "shutdown" });
			if (before.pid !== undefined) await this.#waitForBrokerExit(before.pid);
		}
		await this.#respawnAndConfirm();
		const after = await this.daemonStatus();
		return {
			restarted: true,
			previousPid: before.pid,
			previousSessions: before.sessions.length,
			pid: after.pid,
		};
	}

	async #readBrokerPid(runtimeDir: string): Promise<number | undefined> {
		try {
			const raw: unknown = await Bun.file(join(runtimeDir, BROKER_PID_FILE)).json();
			if (typeof raw === "object" && raw !== null && "pid" in raw && typeof raw.pid === "number") return raw.pid;
		} catch {
			// Missing or malformed broker.pid — no owning broker.
		}
		return undefined;
	}

	async #waitForBrokerExit(pid: number): Promise<void> {
		const deadline = Date.now() + BROKER_EXIT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (!isPidAlive(pid)) return;
			await Bun.sleep(BROKER_EXIT_POLL_MS);
		}
	}

	async #respawnAndConfirm(): Promise<AgentSessionSummary[]> {
		let lastError: unknown;
		for (let attempt = 0; attempt < BROKER_RESPAWN_ATTEMPTS; attempt++) {
			try {
				return await this.list();
			} catch (error) {
				lastError = error;
				await Bun.sleep(BROKER_EXIT_POLL_MS);
			}
		}
		throw new Error(
			`daemon did not come back up after restart: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		);
	}
}
