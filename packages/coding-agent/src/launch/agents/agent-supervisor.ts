/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * Agent supervisor (SPEC §8.1, CONTRACTS.md C4).
 *
 * The routing/attach/peer-delivery/health layer, grafted onto OMP's daemon
 * broker (it never runs providers, tools, or schedulers — those live in the
 * resident workers). Responsibilities:
 *
 *  - own the worker roster (spawn/list/stop);
 *  - route C4 commands to the owning worker and return typed results;
 *  - enforce command idempotency via the {@link CommandJournal} (journal before
 *    dispatch; replay a completed result; report — never replay — an uncertain
 *    one);
 *  - register client attachments and fan out worker events to them, with a
 *    generation-aware replay buffer for reconnect/resume;
 *  - route `send_message` to the target worker (the peer-delivery seam WS5
 *    builds on).
 *
 * It is transport-agnostic: a {@link WorkerSpawner} yields a {@link BrokerSideLink}
 * for each worker (a real subprocess+socket in production, an in-process memory
 * link in tests) and a {@link ClientChannel} is how it pushes events back to one
 * client.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { CommandJournal } from "./command-journal";
import {
	type ActiveSessionId,
	AGENT_CONTROL_PROTOCOL_INFO,
	type AgentAttachResult,
	type AgentClientCapability,
	type AgentClientId,
	type AgentControlCommand,
	type AgentControlCommandEnvelope,
	type AgentControlError,
	type AgentControlEvent,
	type AgentControlEventEnvelope,
	type AgentControlResult,
	type AgentEventCursor,
	type AgentMessageReceipt,
	type AgentReplayInfo,
	type AgentSessionSummary,
	type AgentWorkerLifecycle,
	createAgentEventEnvelope,
	isMutatingAgentCommand,
} from "./control-protocol";
import type { BrokerSideLink, WorkerToBroker } from "./worker-transport";

/** How the supervisor pushes events to one attached client. */
export interface ClientChannel {
	readonly id: AgentClientId;
	readonly capabilities: readonly AgentClientCapability[];
	sendEvent(envelope: AgentControlEventEnvelope): void;
}

export interface WorkerSpawnRequest {
	activeSessionId: ActiveSessionId;
	entityName: string;
	cwd: string;
	token: string;
	generation: string;
}

export interface WorkerSpawner {
	spawn(request: WorkerSpawnRequest): Promise<{ link: BrokerSideLink }>;
}

export interface AgentSupervisorOptions {
	spawner: WorkerSpawner;
	/** Persisted command journal (omit for an in-memory journal). */
	journalPath?: string;
	/** Per-command dispatch timeout. */
	commandTimeoutMs?: number;
	/** Ready/auth handshake timeout. */
	handshakeTimeoutMs?: number;
	/** Event replay-buffer depth per worker. */
	eventBufferSize?: number;
	now?: () => number;
	newId?: () => string;
}

interface PendingCommand {
	resolve: (result: AgentControlResult) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface WorkerRecord {
	id: ActiveSessionId;
	entityName: string;
	cwd: string;
	generation: string;
	token: string;
	link: BrokerSideLink;
	state: AgentWorkerLifecycle;
	createdAt: string;
	lastActivityAt?: string;
	busy: boolean;
	peers: string[];
	readonly attached: Map<AgentClientId, ClientChannel>;
	readonly pending: Map<string, PendingCommand>;
	readonly eventBuffer: AgentControlEventEnvelope[];
	authorized: boolean;
	ready: boolean;
	onAuth?: (accepted: boolean) => void;
	onReady?: () => void;
	onCloseAck?: () => void;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
const DEFAULT_EVENT_BUFFER = 512;
/** Upper bound on waiting for a stopped worker to drain + release its lease. Exceeds the 30s extension-teardown deadline. */
const STOP_DRAIN_TIMEOUT_MS = 35_000;

/** Commands the supervisor handles itself (never forwarded to a worker). */
const SUPERVISOR_LOCAL_COMMANDS: Partial<Record<AgentControlCommand["type"], true>> = {
	spawn: true,
	list: true,
	attach: true,
	detach: true,
	stop: true,
	send_message: true,
};

export class AgentSupervisor {
	readonly #records = new Map<ActiveSessionId, WorkerRecord>();
	readonly #spawner: WorkerSpawner;
	readonly #journal: CommandJournal;
	readonly #commandTimeoutMs: number;
	readonly #handshakeTimeoutMs: number;
	readonly #eventBufferSize: number;
	readonly #now: () => number;
	readonly #newId: () => string;

	constructor(options: AgentSupervisorOptions) {
		this.#spawner = options.spawner;
		this.#journal = new CommandJournal(options.journalPath);
		this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
		this.#eventBufferSize = options.eventBufferSize ?? DEFAULT_EVENT_BUFFER;
		this.#now = options.now ?? Date.now;
		this.#newId = options.newId ?? (() => crypto.randomUUID());
	}

	/**
	 * Entry point for one C4 command from a client. Applies idempotency, routes,
	 * and returns the typed result. Never throws — failures come back as
	 * `{ ok: false, error }`.
	 */
	async handle(envelope: AgentControlCommandEnvelope, client: ClientChannel): Promise<AgentControlResult> {
		const command = envelope.command;
		const clientId = envelope.clientId;
		const journaled = clientId !== undefined && isMutatingAgentCommand(command);

		if (journaled) {
			const admission = this.#journal.begin(clientId, envelope.id);
			if (admission.status === "replay") return admission.result;
			if (admission.status === "uncertain") {
				return this.#error(command.type, {
					code: "command_result_uncertain",
					message: "A prior attempt of this command did not certainly complete; it will not be replayed.",
					clientId,
					commandId: envelope.id,
				});
			}
		}

		let result: AgentControlResult;
		try {
			result = await this.#route(envelope, client);
		} catch (error) {
			result = this.#error(command.type, {
				code: "internal",
				message: error instanceof Error ? error.message : String(error),
			});
		}

		if (journaled && clientId !== undefined) {
			// A clean rejection with a known error and no side effect can be retried;
			// anything that reached a worker (or spawned one) is recorded as final.
			if (
				result.ok === false &&
				(result.error.code === "invalid_command" || result.error.code === "unknown_entity")
			) {
				this.#journal.abort(clientId, envelope.id);
			} else {
				this.#journal.complete(clientId, envelope.id, result);
			}
		}
		return result;
	}

	#route(envelope: AgentControlCommandEnvelope, client: ClientChannel): Promise<AgentControlResult> {
		const command = envelope.command;
		if (!SUPERVISOR_LOCAL_COMMANDS[command.type]) return this.#forward(envelope);
		switch (command.type) {
			case "spawn":
				return this.#spawn(command.entityName, command.cwd);
			case "list":
				return Promise.resolve({ type: "list", ok: true, sessions: this.listSessions() });
			case "attach":
				return this.#attach(command.id, client, command.capabilities ?? [], command.resume);
			case "detach":
				return this.#detach(command.id, client.id);
			case "stop":
				return this.#stop(command.id);
			case "send_message":
				return this.#sendMessage(command.target, command.text, command.mode ?? "auto", command.from);
			default:
				return this.#forward(envelope);
		}
	}

	listSessions(): AgentSessionSummary[] {
		return [...this.#records.values()].map(record => this.#summaryOf(record));
	}

	/** Drop a client (socket) from every session it was attached to. */
	detachClient(clientId: AgentClientId): void {
		for (const record of this.#records.values()) record.attached.delete(clientId);
	}

	async #spawn(entityName: string, cwd?: string): Promise<AgentControlResult> {
		const id = this.#newId();
		const token = this.#newId();
		const generation = this.#newId();
		const resolvedCwd = cwd ?? process.cwd();
		let link: BrokerSideLink;
		try {
			({ link } = await this.#spawner.spawn({
				activeSessionId: id,
				entityName,
				cwd: resolvedCwd,
				token,
				generation,
			}));
		} catch (error) {
			return this.#error("spawn", {
				code: "worker_unavailable",
				message: `Failed to spawn worker for ${entityName}: ${error instanceof Error ? error.message : String(error)}`,
			});
		}

		const record: WorkerRecord = {
			id,
			entityName,
			cwd: resolvedCwd,
			generation,
			token,
			link,
			state: "starting",
			createdAt: new Date(this.#now()).toISOString(),
			busy: false,
			peers: [],
			attached: new Map(),
			pending: new Map(),
			eventBuffer: [],
			authorized: false,
			ready: false,
		};
		this.#records.set(id, record);
		this.#wireLink(record);

		try {
			await this.#awaitHandshake(record);
		} catch (error) {
			this.#teardown(record, "failed");
			return this.#error("spawn", {
				code: "worker_unavailable",
				message: `Worker for ${entityName} did not become ready: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		return { type: "spawn", ok: true, id, summary: this.#summaryOf(record) };
	}

	#wireLink(record: WorkerRecord): void {
		record.link.onMessage(message => this.#onWorkerMessage(record, message));
		record.link.onClose(error => {
			record.onCloseAck?.();
			for (const pending of record.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error(error?.message ?? "worker link closed"));
			}
			record.pending.clear();
			if (record.state !== "stopping") {
				record.state = "failed";
				this.#broadcast(record, { kind: "closed", reason: "failed" });
			}
			this.#records.delete(record.id);
		});
	}

	#onWorkerMessage(record: WorkerRecord, message: WorkerToBroker): void {
		switch (message.type) {
			case "auth": {
				const accepted = message.token === record.token && message.generation === record.generation;
				record.authorized = accepted;
				record.link.send(
					accepted
						? { type: "auth_ok", generation: record.generation }
						: { type: "auth_reject", reason: "token/generation mismatch" },
				);
				record.onAuth?.(accepted);
				break;
			}
			case "lifecycle": {
				record.state = message.state;
				if (message.state === "ready") {
					record.ready = true;
					record.onReady?.();
				}
				break;
			}
			case "event": {
				record.lastActivityAt = new Date(this.#now()).toISOString();
				if (message.event.kind === "status") record.busy = message.event.busy;
				this.#emit(record, message.event, message.cursor);
				break;
			}
			case "result": {
				const pending = record.pending.get(message.commandId);
				if (pending) {
					clearTimeout(pending.timer);
					record.pending.delete(message.commandId);
					pending.resolve(message.result);
				}
				break;
			}
			case "peer_roster":
				record.peers = message.peers;
				break;
		}
	}

	#awaitHandshake(record: WorkerRecord): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => reject(new Error("handshake timeout")), this.#handshakeTimeoutMs);
		record.onAuth = accepted => {
			if (!accepted) {
				clearTimeout(timer);
				reject(new Error("worker authentication rejected"));
			}
		};
		record.onReady = () => {
			clearTimeout(timer);
			resolve();
		};
		if (record.ready) {
			clearTimeout(timer);
			resolve();
		}
		return promise;
	}

	#forward(envelope: AgentControlCommandEnvelope): Promise<AgentControlResult> {
		const command = envelope.command;
		const id = "id" in command ? command.id : undefined;
		const record = id ? this.#records.get(id) : undefined;
		if (!record) {
			return Promise.resolve(
				this.#error(command.type, { code: "unknown_session", message: `No such session: ${id}` }),
			);
		}
		if (!record.ready) {
			return Promise.resolve(this.#error(command.type, { code: "worker_unavailable", message: "worker not ready" }));
		}
		return this.#dispatchToWorker(record, envelope);
	}

	#dispatchToWorker(record: WorkerRecord, envelope: AgentControlCommandEnvelope): Promise<AgentControlResult> {
		const { promise, resolve, reject } = Promise.withResolvers<AgentControlResult>();
		const timer = setTimeout(() => {
			record.pending.delete(envelope.id);
			reject(new Error(`command ${envelope.command.type} timed out`));
		}, this.#commandTimeoutMs);
		record.pending.set(envelope.id, { resolve, reject, timer });
		record.link.send({ type: "command", envelope });
		return promise;
	}

	async #attach(
		id: ActiveSessionId,
		client: ClientChannel,
		capabilities: AgentClientCapability[],
		resume?: AgentEventCursor,
	): Promise<AgentControlResult> {
		const record = this.#records.get(id);
		if (!record) return this.#error("attach", { code: "unknown_session", message: `No such session: ${id}` });
		if (!record.ready) return this.#error("attach", { code: "worker_unavailable", message: "worker not ready" });

		// Ask the worker for the durable snapshot baseline.
		const snapshotResult = await this.#dispatchToWorker(record, {
			type: "command",
			id: this.#newId(),
			protocol: AGENT_CONTROL_PROTOCOL_INFO,
			clientId: client.id,
			command: { type: "attach", id, capabilities, resume },
		});
		if (snapshotResult.type !== "attach" || snapshotResult.ok !== true) return snapshotResult;

		record.attached.set(client.id, client);
		const replay = this.#replay(record, resume, snapshotResult.result.snapshot.lastEventSequence);
		if (replay.status === "complete" || replay.status === "partial") {
			for (const buffered of record.eventBuffer) {
				if (resume && buffered.sequence > resume.sequence) client.sendEvent({ ...buffered, replayed: true });
			}
		}
		const result: AgentAttachResult = { ...snapshotResult.result, replay, client: { id: client.id, capabilities } };
		return { type: "attach", ok: true, result };
	}

	#detach(id: ActiveSessionId, clientId: AgentClientId): Promise<AgentControlResult> {
		const record = this.#records.get(id);
		record?.attached.delete(clientId);
		return Promise.resolve({ type: "detach", ok: true });
	}

	async #stop(id: ActiveSessionId): Promise<AgentControlResult> {
		const record = this.#records.get(id);
		if (!record) return this.#error("stop", { code: "unknown_session", message: `No such session: ${id}` });
		record.state = "stopping";
		// Route a clean C4 shutdown (graft risk #2) and WAIT for the worker to drain
		// and release its session lease (it closes the link only after that) before
		// returning, so an immediate respawn of the same entity cannot race the lease
		// into SessionAlreadyActiveError.
		const drained = Promise.withResolvers<void>();
		record.onCloseAck = () => drained.resolve();
		const timer = setTimeout(() => drained.resolve(), STOP_DRAIN_TIMEOUT_MS);
		record.link.send({ type: "shutdown", reason: "client_stop" });
		await drained.promise;
		clearTimeout(timer);
		this.#broadcast(record, { kind: "closed", reason: "stopped" });
		this.#teardown(record, "stopping");
		return { type: "stop", ok: true };
	}

	async #sendMessage(
		target: string,
		text: string,
		mode: AgentMessageReceipt["mode"],
		from?: string,
	): Promise<AgentControlResult> {
		const record = this.#resolveTarget(target);
		if (!record) {
			return {
				type: "send_message",
				ok: true,
				receipt: { target, outcome: "failed", mode, error: "unknown target" },
			};
		}
		const result = await this.#dispatchToWorker(record, {
			type: "command",
			id: this.#newId(),
			protocol: AGENT_CONTROL_PROTOCOL_INFO,
			command: { type: "send_message", target, text, mode, from },
		});
		if (result.type === "send_message" && result.ok) return result;
		return { type: "send_message", ok: true, receipt: { target, outcome: "failed", mode, error: "delivery failed" } };
	}

	#resolveTarget(target: string): WorkerRecord | undefined {
		if (this.#records.has(target)) return this.#records.get(target);
		for (const record of this.#records.values()) {
			if (record.entityName === target) return record;
		}
		return undefined;
	}

	#emit(record: WorkerRecord, event: AgentControlEvent, cursor: AgentEventCursor): void {
		const envelope = createAgentEventEnvelope(
			event,
			record.id,
			cursor,
			this.#newId(),
			new Date(this.#now()).toISOString(),
		);
		record.eventBuffer.push(envelope);
		if (record.eventBuffer.length > this.#eventBufferSize) record.eventBuffer.shift();
		for (const client of record.attached.values()) {
			try {
				client.sendEvent(envelope);
			} catch (error) {
				logger.warn("agent event fan-out failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/** Emit a supervisor-originated event (session closed etc.) to attached clients. */
	#broadcast(record: WorkerRecord, event: AgentControlEvent): void {
		const cursor: AgentEventCursor = {
			generation: record.generation,
			sequence: (record.eventBuffer.at(-1)?.sequence ?? 0) + 1,
		};
		this.#emit(record, event, cursor);
	}

	#replay(record: WorkerRecord, resume: AgentEventCursor | undefined, lastSequence: number): AgentReplayInfo {
		if (!resume) return { status: "complete", toSequence: lastSequence };
		if (resume.generation !== record.generation) {
			return { status: "unavailable", toSequence: lastSequence, reason: "generation changed; rely on snapshot" };
		}
		const earliest = record.eventBuffer[0]?.sequence;
		if (earliest === undefined || resume.sequence + 1 >= earliest) {
			return { status: "complete", fromSequence: resume.sequence + 1, toSequence: lastSequence, fromCursor: resume };
		}
		return { status: "partial", fromSequence: earliest, toSequence: lastSequence, reason: "replay buffer overran" };
	}

	#teardown(record: WorkerRecord, state: AgentWorkerLifecycle): void {
		record.state = state;
		for (const pending of record.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("worker stopped"));
		}
		record.pending.clear();
		record.attached.clear();
		this.#records.delete(record.id);
		record.link.close();
	}

	#summaryOf(record: WorkerRecord): AgentSessionSummary {
		return {
			id: record.id,
			entityName: record.entityName,
			cwd: record.cwd,
			workerState: record.state,
			attached: record.attached.size > 0,
			busy: record.busy,
			createdAt: record.createdAt,
			lastActivityAt: record.lastActivityAt,
		};
	}

	#error(type: AgentControlCommand["type"], error: AgentControlError): AgentControlResult {
		return { type, ok: false, error };
	}
}
