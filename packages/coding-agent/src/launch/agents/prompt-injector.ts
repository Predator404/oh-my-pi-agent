/**
 * Prompt-injection graft boundary (SPEC §8.2, CONTRACTS.md C5).
 *
 * Every scheduler mode — cron, heartbeat, goal, autonomous — reaches the
 * session through this one interface. It maps a due prompt onto OMP's
 * AgentSession entry points: an idle session gets a fresh turn (`prompt`), a
 * busy session gets a `steer` (interrupt) or `follow_up` (queue) per the job's
 * delivery mode. This is the whole reason dropping the ipython/RLM model costs
 * nothing here — nothing in the scheduler path touches a kernel; it only
 * injects text.
 *
 * The worker backs this with a real AgentSession; tests back it with a stub, so
 * scheduler behavior (claim-and-advance, deferral, idempotency) is verifiable
 * without a live model.
 */

import type { AgentDeliveryMode } from "./control-protocol";

/** Result of a single injection. */
export type InjectOutcome =
	/** Session was idle; a fresh turn was started. */
	| "started"
	/** Session was busy; the prompt interrupted the current turn. */
	| "steered"
	/** Session was busy; the prompt was queued to run after the current turn. */
	| "queued"
	/** The injection was deliberately not delivered (e.g. deferred heartbeat). */
	| "skipped";

/** A snapshot of session activity used to decide heartbeat deferral. */
export interface SessionActivity {
	isStreaming: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	isBashRunning: boolean;
	hasPendingWork: boolean;
	unfinishedActionCount: number;
}

export interface InjectPromptOptions {
	/** Delivery mode to use when the session is busy. */
	whenBusy: AgentDeliveryMode;
	/** Optional label surfaced in logs/diagnostics. */
	label?: string;
}

/**
 * The single seam between the scheduler/goal/autonomous controllers and the
 * live session. Implemented by the resident worker over its AgentSession.
 */
export interface PromptInjector {
	/**
	 * Inject `text`. When idle, starts a turn; when busy, steers or queues per
	 * {@link InjectPromptOptions.whenBusy}. Resolves once the prompt has been
	 * accepted (not once the turn completes).
	 */
	injectPrompt(text: string, options: InjectPromptOptions): Promise<InjectOutcome>;
	/** True while the session is mid-turn. */
	isBusy(): boolean;
	/** Current activity snapshot. */
	activity(): SessionActivity;
}
