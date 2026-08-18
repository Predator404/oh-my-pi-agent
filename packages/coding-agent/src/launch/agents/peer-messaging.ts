/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * See repository-root NOTICE for attribution details.
 *
 * WS5 — coordination / peer messaging (SPEC §4.4, §12.5; CONTRACTS.md C4 consumer).
 *
 * The `agent_message`-equivalent over the daemon. This layer owns the *semantics*
 * that sit on top of WS1's frozen `send_message` control command + supervisor
 * routing seam:
 *
 *  - **Delivery modes** (SPEC §4.4). `auto` steers a busy target / delivers to an
 *    idle one; `steer` injects into the target's active work; `follow_up` queues
 *    behind the current turn. {@link planPeerDelivery} is the single source of
 *    truth for how a `(mode, busy)` pair resolves.
 *  - **Delivery receipts** — delivered vs queued. {@link peerReceiptStatus} maps a
 *    frozen {@link AgentMessageReceipt} onto the Prime `delivered | queued`
 *    status class the acceptance criteria speak in.
 *  - **Roster addressing** by entity name *or* active-session id, and **broadcast
 *    scoped to the roster only** — {@link PeerMessenger.broadcast} fans out over
 *    exactly the sessions the supervisor reports, never beyond.
 *
 * Delivery survives client detach for free: `send_message` routes to the target
 * *resident worker* (the durable sink), not to any attached terminal — see
 * {@link AgentSupervisor}. A detached target is just a resident worker with no
 * client; its session is live and receives the message normally.
 *
 * The class depends only on the narrow {@link PeerMessagingClient} surface, which
 * `AgentDaemonClient` satisfies structurally — so WS7's CLI/TUI and an in-worker
 * peer tool call the same API, and tests can drive it with a fake.
 */

import type { AgentMessageMode, AgentMessageReceipt, AgentSessionSummary } from "./control-protocol";

/** Whether the peer message reached the target's active/next work, or sits queued behind it. */
export type PeerDeliveryStatus = "delivered" | "queued" | "failed";

/** Which live-session primitive a resolved delivery drives. */
export type PeerDeliveryAction =
	/** Start a fresh turn (target idle, or `follow_up` with nothing to queue behind). */
	| "wake"
	/** Inject into the active turn (busy `auto`/`steer`). */
	| "interrupt"
	/** Queue behind the current turn (busy `follow_up`). */
	| "follow_up";

/** The resolved plan for one `(mode, busy)` pair. Pure, so it is exhaustively testable. */
export interface PeerDeliveryPlan {
	action: PeerDeliveryAction;
	/** OMP IRC-family outcome this plan expects (the worker returns the observed one for live deliveries). */
	outcome: "injected" | "woken" | "queued";
	/** The delivered-vs-queued class this plan yields. */
	status: Exclude<PeerDeliveryStatus, "failed">;
	/** Whether the recipient should treat the message as awaiting a reply turn. */
	expectsReply: boolean;
}

/**
 * Resolve how a peer message is delivered, per SPEC §4.4:
 *
 * | mode        | target busy      | target idle                    |
 * |-------------|------------------|--------------------------------|
 * | `auto`      | steer (delivered)| deliver / wake (delivered)     |
 * | `steer`     | interrupt (deliv)| wake (delivered)               |
 * | `follow_up` | queue (queued)   | wake — nothing to queue (deliv)|
 *
 * The only `queued` outcome is `follow_up` into a busy target; every other
 * reachable target yields `delivered`. `auto` never expects a reply (it rides
 * OMP's non-interrupting aside channel when busy); `steer`/`follow_up` do.
 */
export function planPeerDelivery(mode: AgentMessageMode, busy: boolean): PeerDeliveryPlan {
	if (busy && mode === "follow_up") {
		return { action: "follow_up", outcome: "queued", status: "queued", expectsReply: true };
	}
	if (busy) {
		// auto | steer into an active turn: interrupt / aside. Deliberate split on expectsReply:
		// `steer` is an explicit handoff that expects the peer to act/reply (drives IrcBridge's
		// side-channel auto-reply when the target can't run a real reply turn); `auto` rides
		// OMP's default NON-interrupting coordination aside (fire-and-forget FYI, no reply demanded).
		return { action: "interrupt", outcome: "injected", status: "delivered", expectsReply: mode === "steer" };
	}
	// Idle target (any mode) — a fresh turn. follow_up has nothing to queue behind.
	return { action: "wake", outcome: "woken", status: "delivered", expectsReply: mode !== "auto" };
}

/**
 * Classify a delivery {@link AgentMessageReceipt} into the delivered / queued /
 * failed status the SPEC §12.5 acceptance speaks in. `injected`/`woken`/`revived`
 * are all forms of *delivered*; only `queued` sits behind the current turn.
 */
export function peerReceiptStatus(receipt: AgentMessageReceipt): PeerDeliveryStatus {
	switch (receipt.outcome) {
		case "queued":
			return "queued";
		case "failed":
			return "failed";
		default:
			return "delivered";
	}
}

/** Render a peer message as a queued follow-up body, preserving the sender. */
export function formatPeerFollowUp(from: string, text: string): string {
	return `[peer message from ${from}]\n${text}`;
}

/** One addressable roster member, as the peer layer sees it. */
export interface PeerRosterEntry {
	id: string;
	entityName: string;
	busy: boolean;
	attached: boolean;
}

/** Result of a roster broadcast: one receipt per delivered-to member, plus the excluded sender. */
export interface PeerBroadcastResult {
	scope: "roster";
	/** The sender id/name excluded from delivery, if any. */
	from?: string;
	/** Members addressed (roster minus sender). */
	recipients: PeerRosterEntry[];
	/** One receipt per recipient, index-aligned with {@link recipients}. */
	receipts: AgentMessageReceipt[];
}

/**
 * The narrow broker surface {@link PeerMessenger} needs. `AgentDaemonClient`
 * satisfies it structurally; tests supply a fake.
 */
export interface PeerMessagingClient {
	sendMessage(target: string, text: string, mode?: AgentMessageMode, from?: string): Promise<AgentMessageReceipt>;
	list(): Promise<AgentSessionSummary[]>;
}

/**
 * The peer-message API surface (the seam WS7's CLI/TUI + an in-worker peer tool
 * call). Thin, typed, and transport-agnostic over {@link PeerMessagingClient}.
 */
export class PeerMessenger {
	readonly #client: PeerMessagingClient;

	constructor(client: PeerMessagingClient) {
		this.#client = client;
	}

	/** The addressable roster (every resident worker the supervisor reports). */
	async roster(): Promise<PeerRosterEntry[]> {
		const sessions = await this.#client.list();
		return sessions.map(s => ({ id: s.id, entityName: s.entityName, busy: s.busy, attached: s.attached }));
	}

	/**
	 * Send one peer message to `target` (entity name or active-session id) in the
	 * given `mode` (default `auto`). Returns the delivery receipt. Survives detach:
	 * the message routes to the target's resident worker regardless of whether a
	 * client is attached.
	 */
	send(target: string, text: string, mode: AgentMessageMode = "auto", from?: string): Promise<AgentMessageReceipt> {
		return this.#client.sendMessage(target, text, mode, from);
	}

	/**
	 * Broadcast `text` to every roster member except the sender. Scoped to the
	 * roster only — it addresses exactly the sessions `list()` reports, never a
	 * wider audience. Deliveries run concurrently; the result index-aligns
	 * recipients with their receipts.
	 */
	async broadcast(text: string, mode: AgentMessageMode = "auto", from?: string): Promise<PeerBroadcastResult> {
		const recipients = (await this.roster()).filter(member => member.id !== from && member.entityName !== from);
		const receipts = await Promise.all(
			recipients.map(member => this.#client.sendMessage(member.id, text, mode, from)),
		);
		return { scope: "roster", from, recipients, receipts };
	}
}
