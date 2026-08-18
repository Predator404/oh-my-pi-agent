/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * C4 — Daemon control protocol (SPEC §8.3).
 *
 * The public JSONL protocol between clients (CLI/TUI/RPC) and the daemon broker
 * for resident agent-session workers. Shapes (command/event envelopes, event
 * cursors, capability negotiation, reconnect/resume, attach snapshots) are
 * adopted from Prime Agent's `daemon-protocol.ts` (v7); the command SET is the
 * agent-session surface frozen in CONTRACTS.md C4. Unlike Prime, there is NO
 * kernel/RLM coupling here — every mutating command ends up injecting a normal
 * prompt into OMP's YieldQueue.
 *
 * These agent-control envelopes travel over OMP's existing broker socket
 * (`launch/protocol.ts`) wrapped in the `agent_command` DaemonOperation; the
 * broker pushes {@link AgentControlEventEnvelope}s back to an attached client as
 * unsolicited wire frames.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/** Protocol identity carried in every command/event envelope. */
export const AGENT_CONTROL_PROTOCOL_NAME = "omp-agent.daemon";
export const AGENT_CONTROL_PROTOCOL_VERSION = 1;

export interface AgentControlProtocolInfo {
	name: typeof AGENT_CONTROL_PROTOCOL_NAME;
	version: number;
}

export const AGENT_CONTROL_PROTOCOL_INFO: AgentControlProtocolInfo = {
	name: AGENT_CONTROL_PROTOCOL_NAME,
	version: AGENT_CONTROL_PROTOCOL_VERSION,
};

/** Opaque client identity; combined with a command id it keys the idempotency journal. */
export type AgentClientId = string;
export type AgentCommandId = string;
export type AgentEventId = string;
export type AgentEventSequence = number;

/**
 * A running worker session's stable identity. Equal to the AgentSession id the
 * worker owns; the spawn command mints it and every later command targets it.
 */
export type ActiveSessionId = string;

/**
 * Generation-aware event cursor. `generation` changes whenever the worker's
 * event source restarts (worker crash/replacement), so a client can tell the
 * broker exactly where it left off and the broker can decide whether replay is
 * possible.
 */
export interface AgentEventCursor {
	generation: string;
	sequence: AgentEventSequence;
}

export type AgentReplayStatus = "complete" | "partial" | "unavailable";

export interface AgentReplayInfo {
	status: AgentReplayStatus;
	fromSequence?: AgentEventSequence;
	toSequence: AgentEventSequence;
	fromCursor?: AgentEventCursor;
	toCursor?: AgentEventCursor;
	reason?: string;
}

/** Client-declared capabilities negotiated at attach. */
export type AgentClientCapability =
	| "attach_snapshot"
	| "event_sequence"
	| "slim_attach"
	| "chunked_snapshot"
	| "client_owned_sessions";

export const AGENT_DEFAULT_CLIENT_CAPABILITIES: readonly AgentClientCapability[] = [
	"attach_snapshot",
	"event_sequence",
];

export const AGENT_SUPPORTED_CLIENT_CAPABILITIES: readonly AgentClientCapability[] = [
	"attach_snapshot",
	"event_sequence",
	"slim_attach",
	"client_owned_sessions",
];

/** How a scheduled/peer prompt is delivered when the target session is busy. */
export type AgentDeliveryMode = "steer" | "follow_up";

/** How a peer message is routed relative to the target's current activity. */
export type AgentMessageMode = "auto" | "steer" | "follow_up";

// ---------------------------------------------------------------------------
// Command set (client → broker). CONTRACTS.md C4.
// ---------------------------------------------------------------------------

/** A schedule specification accepted by `schedule_add` (parsed worker-side). */
export interface AgentScheduleSpec {
	/** Free-form schedule text: "every 5m", "in 30s", "at 14:00", cron "0 9 * * *". */
	schedule: string;
	prompt: string;
	label?: string;
	deliveryMode?: AgentDeliveryMode;
}

/** A goal objective specification accepted by `goal_set`. */
export interface AgentGoalSpec {
	objective: string;
	tokenBudget?: number;
}

/** Bounded autonomous-mode limits accepted by `autonomous_on`. */
export interface AgentAutonomousSpec {
	maxContinuations?: number;
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	continuationPrompt?: string;
	gates?: { commands?: string[]; maxRetries?: number; timeoutMs?: number };
}

export type AgentControlCommand =
	// Lifecycle -------------------------------------------------------------
	| { type: "spawn"; entityName: string; cwd?: string }
	| { type: "attach"; id: ActiveSessionId; capabilities?: AgentClientCapability[]; resume?: AgentEventCursor }
	| { type: "detach"; id: ActiveSessionId }
	| { type: "list" }
	| { type: "stop"; id: ActiveSessionId }
	// Prompt injection ------------------------------------------------------
	| { type: "prompt"; id: ActiveSessionId; text: string }
	| { type: "steer"; id: ActiveSessionId; text: string }
	| { type: "follow_up"; id: ActiveSessionId; text: string }
	// Peer messaging (consumed by WS5) --------------------------------------
	| { type: "send_message"; target: string; text: string; mode?: AgentMessageMode; from?: string }
	// Scheduler: cron/one-off ----------------------------------------------
	| { type: "schedule_add"; id: ActiveSessionId; spec: AgentScheduleSpec }
	| { type: "schedule_list"; id: ActiveSessionId; includeInactive?: boolean }
	| { type: "schedule_cancel"; id: ActiveSessionId; jobId: string }
	// Scheduler: heartbeat --------------------------------------------------
	| {
			type: "heartbeat_set";
			id: ActiveSessionId;
			schedule: string;
			instruction: string;
			deliveryMode?: AgentDeliveryMode;
	  }
	| { type: "heartbeat_pause"; id: ActiveSessionId }
	| { type: "heartbeat_resume"; id: ActiveSessionId }
	| { type: "heartbeat_clear"; id: ActiveSessionId }
	// Scheduler: durable goal ----------------------------------------------
	| { type: "goal_set"; id: ActiveSessionId; spec: AgentGoalSpec }
	| { type: "goal_status"; id: ActiveSessionId }
	| { type: "goal_pause"; id: ActiveSessionId }
	| { type: "goal_resume"; id: ActiveSessionId }
	| { type: "goal_clear"; id: ActiveSessionId }
	// Scheduler: bounded autonomous mode ------------------------------------
	| { type: "autonomous_on"; id: ActiveSessionId; spec?: AgentAutonomousSpec }
	| { type: "autonomous_off"; id: ActiveSessionId }
	| { type: "autonomous_status"; id: ActiveSessionId };

export type AgentControlCommandType = AgentControlCommand["type"];

/**
 * Read-only commands are never journaled for idempotency — replaying them is
 * safe. Everything else mutates worker/session state.
 */
const READ_ONLY_AGENT_COMMANDS: Partial<Record<AgentControlCommandType, true>> = {
	list: true,
	schedule_list: true,
	goal_status: true,
	autonomous_status: true,
};

export function isMutatingAgentCommand(command: Pick<AgentControlCommand, "type">): boolean {
	return READ_ONLY_AGENT_COMMANDS[command.type] !== true;
}

/** Command envelope (client → broker). Adopted from Prime v7. */
export interface AgentControlCommandEnvelope<TCommand extends AgentControlCommand = AgentControlCommand> {
	type: "command";
	id: AgentCommandId;
	protocol: AgentControlProtocolInfo;
	clientId?: AgentClientId;
	command: TCommand;
}

export function createAgentCommandEnvelope<TCommand extends AgentControlCommand>(
	command: TCommand,
	id: AgentCommandId,
	clientId?: AgentClientId,
): AgentControlCommandEnvelope<TCommand> {
	return { type: "command", id, protocol: AGENT_CONTROL_PROTOCOL_INFO, clientId, command };
}

// ---------------------------------------------------------------------------
// Command responses (broker → client, matched to the command id).
// ---------------------------------------------------------------------------

/** One row in a `list` response. */
export interface AgentSessionSummary {
	id: ActiveSessionId;
	entityName: string;
	cwd: string;
	/** Worker lifecycle as observed by the broker. */
	workerState: AgentWorkerLifecycle;
	/** True when a client is currently attached. */
	attached: boolean;
	/** True when the session is mid-turn (streaming). */
	busy: boolean;
	createdAt: string;
	lastActivityAt?: string;
}

/**
 * The durable attach baseline. Adopted from Prime `DaemonSessionSnapshot`,
 * minus RLM child trees. Streamed in chunks when `chunked_snapshot` is
 * negotiated (see {@link AgentSnapshotChunk}).
 */
export interface AgentSessionSnapshot {
	activeSessionId: ActiveSessionId;
	entityName: string;
	summary: AgentSessionSummary;
	/** Full in-context message history. Omitted for `slim_attach` clients (use the chunk stream). */
	messages?: AgentMessage[];
	messageCount: number;
	lastEventSequence: AgentEventSequence;
	lastEventCursor: AgentEventCursor;
	replay: AgentReplayInfo;
}

/**
 * Snapshot chunk for streaming an oversized attach baseline. RESERVED: the
 * frozen wire shape is retained for a future implementation, but the server
 * does not yet advertise `chunked_snapshot` and always returns messages inline,
 * so no chunk event is currently emitted.
 */
export interface AgentSnapshotChunk {
	type: "snapshot_begin" | "snapshot_chunk" | "snapshot_end";
	activeSessionId: ActiveSessionId;
	streamId: string;
	/** Present on `snapshot_chunk`: a slice of the message history. */
	messages?: AgentMessage[];
	/** Present on `snapshot_begin`. */
	messageCount?: number;
	targetChunkBytes?: number;
}

/** Target size of a single snapshot chunk. Adopted from Prime (512 KiB). */
export const AGENT_SNAPSHOT_CHUNK_BYTES = 512 * 1024;

export interface AgentAttachResult {
	protocol: AgentControlProtocolInfo;
	activeSessionId: ActiveSessionId;
	snapshot: AgentSessionSnapshot;
	replay: AgentReplayInfo;
	client: { id: AgentClientId; capabilities: AgentClientCapability[] };
	snapshotStream?: { id: string; messageCount: number; targetChunkBytes: number };
}

/** A scheduled job as surfaced to clients (C5 shape; see artifacts.ts). */
export interface AgentScheduledJobView {
	id: string;
	label?: string;
	source: "cron" | "heartbeat";
	kind: "once" | "cron" | "interval";
	status: "active" | "paused" | "completed" | "cancelled";
	prompt: string;
	schedule: string;
	deliveryMode?: AgentDeliveryMode;
	nextRunAt?: string;
	lastRunAt?: string;
	runCount: number;
}

export interface AgentGoalView {
	active: boolean;
	status: "idle" | "active" | "paused" | "budget_limited" | "complete" | "error";
	goalId?: string;
	objective?: string;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	continuationsUsed: number;
}

export interface AgentAutonomousView {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	startedAt?: number;
	limits: { maxContinuations: number; maxTurns: number; maxTokens: number; timeoutMs: number };
}

/** Delivery receipt for `send_message`. Mirrors OMP's IRC delivery outcomes. */
export interface AgentMessageReceipt {
	target: string;
	outcome: "injected" | "woken" | "revived" | "queued" | "failed";
	mode: AgentMessageMode;
	error?: string;
}

/**
 * Typed command results, discriminated by the command type they answer. `ok:
 * false` carries a structured error; `session_already_active` and
 * `command_result_uncertain` are the two the client must special-case
 * (idempotency + lease conflict).
 */
export type AgentControlResult =
	| { type: "spawn"; ok: true; id: ActiveSessionId; summary: AgentSessionSummary }
	| { type: "attach"; ok: true; result: AgentAttachResult }
	| { type: "detach"; ok: true }
	| { type: "list"; ok: true; sessions: AgentSessionSummary[] }
	| { type: "stop"; ok: true }
	| { type: "prompt" | "steer" | "follow_up"; ok: true; accepted: boolean }
	| { type: "send_message"; ok: true; receipt: AgentMessageReceipt }
	| { type: "schedule_add"; ok: true; job: AgentScheduledJobView }
	| { type: "schedule_list"; ok: true; jobs: AgentScheduledJobView[] }
	| { type: "schedule_cancel"; ok: true; cancelled: boolean }
	| {
			type: "heartbeat_set" | "heartbeat_pause" | "heartbeat_resume" | "heartbeat_clear";
			ok: true;
			job?: AgentScheduledJobView;
	  }
	| { type: "goal_set" | "goal_status" | "goal_pause" | "goal_resume" | "goal_clear"; ok: true; goal: AgentGoalView }
	| { type: "autonomous_on" | "autonomous_off" | "autonomous_status"; ok: true; status: AgentAutonomousView }
	| { type: AgentControlCommandType; ok: false; error: AgentControlError };

export type AgentControlErrorCode =
	| "unknown_session"
	| "unknown_entity"
	| "session_already_active"
	| "command_result_uncertain"
	| "worker_unavailable"
	| "invalid_command"
	| "internal";

export interface AgentControlError {
	code: AgentControlErrorCode;
	message: string;
	/** Present for `session_already_active`. */
	sessionPath?: string;
	/** Present for `command_result_uncertain` — echoes the journal key. */
	clientId?: AgentClientId;
	commandId?: AgentCommandId;
}

export interface AgentControlResponseEnvelope {
	type: "response";
	id: AgentCommandId;
	protocol: AgentControlProtocolInfo;
	result: AgentControlResult;
}

// ---------------------------------------------------------------------------
// Event stream (broker → attached client), generation + sequence ordered.
// ---------------------------------------------------------------------------

/**
 * Session events streamed to attached clients. Kept deliberately small: the
 * durable baseline is the attach snapshot, events carry incremental deltas.
 */
export type AgentControlEvent =
	| { kind: "message"; message: AgentMessage }
	| { kind: "status"; busy: boolean; recap?: string }
	| { kind: "schedule_changed" }
	| { kind: "goal_changed"; goal: AgentGoalView }
	| { kind: "autonomous_changed"; status: AgentAutonomousView }
	| { kind: "snapshot"; chunk: AgentSnapshotChunk }
	| { kind: "detached" }
	| { kind: "closed"; reason: AgentSessionClosedReason };

export type AgentSessionClosedReason = "stopped" | "shutdown" | "completed" | "replaced" | "failed";

export interface AgentControlEventEnvelope<TEvent extends AgentControlEvent = AgentControlEvent> {
	type: "event";
	id: AgentEventId;
	protocol: AgentControlProtocolInfo;
	activeSessionId: ActiveSessionId;
	sequence: AgentEventSequence;
	cursor: AgentEventCursor;
	emittedAt: string;
	replayed?: boolean;
	event: TEvent;
}

export function createAgentEventEnvelope<TEvent extends AgentControlEvent>(
	event: TEvent,
	activeSessionId: ActiveSessionId,
	cursor: AgentEventCursor,
	id: AgentEventId,
	emittedAt = new Date().toISOString(),
): AgentControlEventEnvelope<TEvent> {
	return {
		type: "event",
		id,
		protocol: AGENT_CONTROL_PROTOCOL_INFO,
		activeSessionId,
		sequence: cursor.sequence,
		cursor,
		emittedAt,
		event,
	};
}

// ---------------------------------------------------------------------------
// Worker lifecycle (shared with the private worker transport).
// ---------------------------------------------------------------------------

/** Worker lifecycle states. Adopted from Prime `daemon-worker-protocol.ts`. */
export type AgentWorkerLifecycle = "starting" | "ready" | "recovering" | "stopping" | "failed";

// ---------------------------------------------------------------------------
// Wire guards (used by the broker to validate frames off an untrusted socket).
// ---------------------------------------------------------------------------

export function isAgentControlCommandEnvelope(value: unknown): value is AgentControlCommandEnvelope {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || value.type !== "command") return false;
	if (!("id" in value) || typeof value.id !== "string") return false;
	if (!("command" in value)) return false;
	const command = value.command;
	return typeof command === "object" && command !== null && "type" in command && typeof command.type === "string";
}

export function isAgentControlResult(value: unknown): value is AgentControlResult {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || typeof value.type !== "string") return false;
	return "ok" in value && typeof value.ok === "boolean";
}

export function isAgentControlEventEnvelope(value: unknown): value is AgentControlEventEnvelope {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || value.type !== "event") return false;
	if (!("event" in value)) return false;
	return typeof value.event === "object" && value.event !== null;
}
