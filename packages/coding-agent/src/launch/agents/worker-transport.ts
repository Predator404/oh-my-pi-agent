/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * Private worker↔broker transport (SPEC §8.3, CONTRACTS.md C4).
 *
 * Two layers:
 *  1. Frame codec — the wire format adopted from Prime `daemon-worker-protocol.ts`:
 *     `[4B header-len][4B payload-len][header JSON][opaque payload]`. The header
 *     is a small JSON control object; the payload carries bulk bytes (snapshot
 *     chunks) so large transfers never bloat the JSON header.
 *  2. WorkerLink — a typed, bidirectional channel used by the supervisor and the
 *     resident worker. Production wraps a `net.Socket` via {@link SocketWorkerLink};
 *     tests use {@link createMemoryLinkPair}, which lets the whole
 *     attach/detach/scheduled-injection path run in one process without spawning
 *     a subprocess or a real model.
 *
 * Security/liveness: each worker authenticates with a per-worker token and is
 * fenced to the supervisor `generation` that spawned it; frames carrying a stale
 * generation are dropped (a resurrected supervisor never adopts a zombie worker).
 */

import type { Socket } from "node:net";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	ActiveSessionId,
	AgentClientCapability,
	AgentClientId,
	AgentControlCommandEnvelope,
	AgentControlEvent,
	AgentControlResult,
	AgentEventCursor,
	AgentWorkerLifecycle,
} from "./control-protocol";

// --- bootstrap env (broker → spawned worker process) ----------------------

/** Hidden CLI selector that re-enters the process as an agent-session worker. */
export const AGENT_WORKER_ARG = "__omp_worker_agent_session";

export const AGENT_WORKER_ROLE_ENV = "OMP_AGENT_WORKER";
export const AGENT_WORKER_TOKEN_ENV = "OMP_AGENT_WORKER_TOKEN";
export const AGENT_WORKER_GENERATION_ENV = "OMP_AGENT_WORKER_GENERATION";
export const AGENT_WORKER_ENTITY_ENV = "OMP_AGENT_WORKER_ENTITY";
export const AGENT_WORKER_ACTIVE_SESSION_ID_ENV = "OMP_AGENT_WORKER_ACTIVE_SESSION_ID";
export const AGENT_WORKER_SESSION_FILE_ENV = "OMP_AGENT_WORKER_SESSION_FILE";
export const AGENT_WORKER_CWD_ENV = "OMP_AGENT_WORKER_CWD";
export const AGENT_WORKER_ENDPOINT_ENV = "OMP_AGENT_WORKER_ENDPOINT";

export function isAgentWorkerProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[AGENT_WORKER_ROLE_ENV] === "1";
}

// --- frame codec -----------------------------------------------------------

const HEADER_PREFIX_BYTES = 8;
/** Hard cap on a single frame's JSON header (guards against a corrupt length). */
const MAX_HEADER_BYTES = 8 * 1024 * 1024;
/** Hard cap on a single frame's opaque payload. */
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** Encode one frame: 4B header length, 4B payload length, header JSON, payload. */
export function encodeFrame(header: unknown, payload?: Uint8Array): Buffer {
	const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
	const payloadBytes = payload ? Buffer.from(payload) : Buffer.alloc(0);
	const frame = Buffer.allocUnsafe(HEADER_PREFIX_BYTES + headerBytes.length + payloadBytes.length);
	frame.writeUInt32BE(headerBytes.length, 0);
	frame.writeUInt32BE(payloadBytes.length, 4);
	headerBytes.copy(frame, HEADER_PREFIX_BYTES);
	payloadBytes.copy(frame, HEADER_PREFIX_BYTES + headerBytes.length);
	return frame;
}

export interface DecodedFrame {
	header: unknown;
	payload: Buffer;
}

/**
 * Streaming frame parser: feed it socket chunks, it yields whole frames as they
 * complete. Tolerates frames split across chunks and multiple frames per chunk.
 */
export class FrameParser {
	#buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): DecodedFrame[] {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		const frames: DecodedFrame[] = [];
		while (this.#buffer.length >= HEADER_PREFIX_BYTES) {
			const headerLen = this.#buffer.readUInt32BE(0);
			const payloadLen = this.#buffer.readUInt32BE(4);
			if (headerLen > MAX_HEADER_BYTES || payloadLen > MAX_PAYLOAD_BYTES) {
				throw new Error(`Worker frame exceeds size cap: header=${headerLen} payload=${payloadLen}`);
			}
			const total = HEADER_PREFIX_BYTES + headerLen + payloadLen;
			if (this.#buffer.length < total) break;
			const headerText = this.#buffer.toString("utf8", HEADER_PREFIX_BYTES, HEADER_PREFIX_BYTES + headerLen);
			const payload = this.#buffer.subarray(HEADER_PREFIX_BYTES + headerLen, total);
			frames.push({ header: JSON.parse(headerText), payload: Buffer.from(payload) });
			this.#buffer = this.#buffer.subarray(total);
		}
		return frames;
	}
}

// --- typed messages --------------------------------------------------------

/** Worker → broker. */
export type WorkerToBroker =
	| {
			type: "auth";
			token: string;
			generation: string;
			activeSessionId: ActiveSessionId;
			entityName: string;
			cwd: string;
	  }
	| { type: "lifecycle"; state: AgentWorkerLifecycle }
	/** A session event, sequenced by the worker's own cursor. */
	| { type: "event"; event: AgentControlEvent; cursor: AgentEventCursor }
	/** Result of a broker-dispatched command, matched by commandId. */
	| { type: "result"; commandId: string; result: AgentControlResult }
	/** Current peer roster this worker knows (for send_message routing). */
	| { type: "peer_roster"; peers: string[] };

/** Broker → worker. */
export type BrokerToWorker =
	| { type: "auth_ok"; generation: string }
	| { type: "auth_reject"; reason: string }
	/** A public C4 command routed to this worker; reply with a `result`. */
	| { type: "command"; envelope: AgentControlCommandEnvelope }
	/** A client attached; begin streaming events (and a snapshot) to it. */
	| { type: "attach"; clientId: AgentClientId; capabilities: AgentClientCapability[]; resume?: AgentEventCursor }
	/** A client detached. */
	| { type: "detach"; clientId: AgentClientId }
	/** A peer message delivered into this worker's session. */
	| { type: "deliver_message"; from: string; text: string; mode: "auto" | "steer" | "follow_up" }
	/** Graceful stop request (routed C4 stop, never a raw signal — graft risk #2). */
	| { type: "shutdown"; reason: string };

/** A bulk snapshot chunk carried in a frame payload (header names the stream). */
export interface SnapshotFramePayload {
	messages: AgentMessage[];
}

// --- typed link ------------------------------------------------------------

/** One end of the worker↔broker channel, typed to the sender's direction. */
export interface WorkerLink<TSend, TRecv> {
	send(message: TSend, payload?: Uint8Array): void;
	onMessage(handler: (message: TRecv, payload: Buffer) => void): void;
	onClose(handler: (error?: Error) => void): void;
	close(): void;
}

export type WorkerSideLink = WorkerLink<WorkerToBroker, BrokerToWorker>;
export type BrokerSideLink = WorkerLink<BrokerToWorker, WorkerToBroker>;

/** Wrap a duplex socket in a typed {@link WorkerLink} using the frame codec. */
export class SocketWorkerLink<TSend, TRecv> implements WorkerLink<TSend, TRecv> {
	readonly #socket: Socket;
	readonly #parser = new FrameParser();
	#messageHandler?: (message: TRecv, payload: Buffer) => void;
	#pending: Array<[TRecv, Buffer]> = [];
	#closeHandler?: (error?: Error) => void;
	#closed = false;

	constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", chunk => {
			let frames: DecodedFrame[];
			try {
				frames = this.#parser.push(chunk as Buffer);
			} catch (error) {
				this.#fail(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			for (const frame of frames) {
				if (this.#messageHandler) this.#messageHandler(frame.header as TRecv, frame.payload);
				else this.#pending.push([frame.header as TRecv, frame.payload]);
			}
		});
		socket.on("error", error => this.#fail(error));
		socket.on("close", () => this.#fail());
	}

	send(message: TSend, payload?: Uint8Array): void {
		if (this.#closed) return;
		this.#socket.write(encodeFrame(message, payload));
	}

	onMessage(handler: (message: TRecv, payload: Buffer) => void): void {
		this.#messageHandler = handler;
		const pending = this.#pending;
		this.#pending = [];
		for (const [message, payload] of pending) handler(message, payload);
	}

	onClose(handler: (error?: Error) => void): void {
		this.#closeHandler = handler;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket.end();
	}

	#fail(error?: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeHandler?.(error);
	}
}

/**
 * An in-process paired link. Returns the two ends of one channel; whatever one
 * end sends the other receives (on a microtask, to mimic async delivery). Used
 * by tests and by an in-process supervisor mode.
 */
export function createMemoryLinkPair(): { broker: BrokerSideLink; worker: WorkerSideLink } {
	const brokerEnd = new MemoryLink<BrokerToWorker, WorkerToBroker>();
	const workerEnd = new MemoryLink<WorkerToBroker, BrokerToWorker>();
	brokerEnd.attach(workerEnd);
	workerEnd.attach(brokerEnd);
	return { broker: brokerEnd, worker: workerEnd };
}

class MemoryLink<TSend, TRecv> implements WorkerLink<TSend, TRecv> {
	#peer?: MemoryLink<TRecv, TSend>;
	#messageHandler?: (message: TRecv, payload: Buffer) => void;
	#pending: Array<[TRecv, Buffer]> = [];
	#closeHandler?: (error?: Error) => void;
	#closed = false;

	attach(peer: MemoryLink<TRecv, TSend>): void {
		this.#peer = peer;
	}

	deliver(message: TRecv, payload: Buffer): void {
		if (this.#closed) return;
		if (this.#messageHandler) this.#messageHandler(message, payload);
		else this.#pending.push([message, payload]);
	}

	send(message: TSend, payload?: Uint8Array): void {
		if (this.#closed) return;
		const peer = this.#peer;
		if (!peer) return;
		// Round-trip through the codec so tests exercise real (de)serialization.
		const encoded = encodeFrame(message, payload);
		const [frame] = new FrameParser().push(encoded);
		queueMicrotask(() => peer.deliver(frame.header as TSend, frame.payload));
	}

	onMessage(handler: (message: TRecv, payload: Buffer) => void): void {
		this.#messageHandler = handler;
		const pending = this.#pending;
		this.#pending = [];
		for (const [message, payload] of pending) handler(message, payload);
	}

	onClose(handler: (error?: Error) => void): void {
		this.#closeHandler = handler;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const peer = this.#peer;
		queueMicrotask(() => {
			this.#closeHandler?.();
			peer?.close();
		});
	}
}
