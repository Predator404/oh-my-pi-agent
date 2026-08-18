/**
 * Resident session abstraction + prompt-injector adapter (SPEC §8.1/§8.2).
 *
 * `ResidentSession` is the narrow surface the resident worker needs from a live
 * OMP AgentSession: inject prompts, stream events, read/append C5 artifact
 * entries, and dispose cleanly. Keeping it an interface is what makes the
 * worker's attach/detach and scheduled-injection logic testable without a live
 * model — {@link AgentSessionResidentSession} binds it to a real AgentSession,
 * while tests supply a fake.
 *
 * The OMP tool surface inside the session is untouched: this adapter only calls
 * AgentSession's existing public entry points.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { IrcMessage } from "../../irc/bus";
import type { AgentSession } from "../../session/agent-session";
import type { CustomEntryLike, GoalCheckpointData, JobOutcomeData } from "./artifacts";
import { GOAL_CHECKPOINT_CUSTOM_TYPE, JOB_OUTCOME_CUSTOM_TYPE } from "./artifacts";
import type { AgentMessageMode, AgentMessageReceipt } from "./control-protocol";
import { formatPeerFollowUp, planPeerDelivery } from "./peer-messaging";
import type { InjectOutcome, InjectPromptOptions, PromptInjector, SessionActivity } from "./prompt-injector";

/** The minimal live-session surface the resident worker consumes. */
export interface ResidentSession {
	readonly activeSessionId: string;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly cwd: string;
	isStreaming(): boolean;
	activity(): SessionActivity;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	deliverMessage(from: string, text: string, mode: AgentMessageMode): Promise<AgentMessageReceipt["outcome"]>;
	/** In-context message history — the attach-snapshot baseline. */
	getMessages(): AgentMessage[];
	/** Session entries, for reading the latest goal checkpoint. */
	getEntries(): CustomEntryLike[];
	getArtifactsDir(): string | null;
	/** Cumulative token usage totals, for feeding goal/autonomous budgets per turn. */
	getUsageTotals(): { input: number; output: number };
	appendGoalCheckpoint(data: GoalCheckpointData): void;
	appendJobOutcome(data: JobOutcomeData): void;
	/** Subscribe to new in-context messages (for the attach event stream). */
	onMessage(handler: (message: AgentMessage) => void): () => void;
	/** Subscribe to run-state (busy/idle) transitions. */
	onRunStateChange(handler: (busy: boolean) => void): () => void;
	dispose(reason: string): Promise<void>;
}

/** Binds {@link ResidentSession} to a live OMP AgentSession. */
export class AgentSessionResidentSession implements ResidentSession {
	readonly activeSessionId: string;

	constructor(
		private readonly session: AgentSession,
		activeSessionId: string,
	) {
		this.activeSessionId = activeSessionId;
	}

	get sessionId(): string {
		return this.session.sessionManager.getSessionId();
	}

	get sessionFile(): string | undefined {
		return this.session.sessionManager.getSessionFile();
	}

	get cwd(): string {
		return this.session.sessionManager.getCwd();
	}

	isStreaming(): boolean {
		return this.session.isStreaming;
	}

	activity(): SessionActivity {
		const streaming = this.session.isStreaming;
		return {
			isStreaming: streaming,
			isCompacting: false,
			isRetrying: false,
			isBashRunning: false,
			hasPendingWork: streaming,
			unfinishedActionCount: 0,
		};
	}

	async prompt(text: string): Promise<void> {
		await this.session.prompt(text, { expandPromptTemplates: false });
	}

	async steer(text: string): Promise<void> {
		await this.session.steer(text);
	}

	async followUp(text: string): Promise<void> {
		await this.session.followUp(text, undefined, { expandPromptTemplates: false });
	}

	async deliverMessage(from: string, text: string, mode: AgentMessageMode): Promise<AgentMessageReceipt["outcome"]> {
		const plan = planPeerDelivery(mode, this.session.isStreaming);
		if (plan.action === "follow_up") {
			// Busy target + follow_up: queue behind the current turn (distinct from a mid-turn
			// interrupt), keeping the sender visible in the rendered body.
			await this.followUp(formatPeerFollowUp(from, text));
			return "queued";
		}
		// auto/steer into an active turn, or any mode into an idle session: deliver via OMP's
		// IRC path (interrupt-aside when busy -> "injected"; wake when idle -> "woken"). Its
		// observed outcome is authoritative if busy/idle shifted since the plan resolved.
		const message: IrcMessage = {
			id: crypto.randomUUID(),
			from,
			to: this.activeSessionId,
			body: text,
			ts: Date.now(),
		};
		return this.session.deliverIrcMessage(message, { expectsReply: plan.expectsReply });
	}

	getMessages(): AgentMessage[] {
		return this.session.messages;
	}

	getEntries(): CustomEntryLike[] {
		return this.session.sessionManager.getEntries() as unknown as CustomEntryLike[];
	}

	getArtifactsDir(): string | null {
		return this.session.sessionManager.getArtifactsDir();
	}

	getUsageTotals(): { input: number; output: number } {
		const usage = this.session.sessionManager.getUsageStatistics();
		return { input: usage.input, output: usage.output };
	}

	appendGoalCheckpoint(data: GoalCheckpointData): void {
		this.session.sessionManager.appendCustomEntry(GOAL_CHECKPOINT_CUSTOM_TYPE, data);
	}

	appendJobOutcome(data: JobOutcomeData): void {
		this.session.sessionManager.appendCustomEntry(JOB_OUTCOME_CUSTOM_TYPE, data);
	}

	onMessage(handler: (message: AgentMessage) => void): () => void {
		// Forward settled messages (one per completed turn message) rather than
		// per-delta message_update, keeping the attach event stream low-volume;
		// the attach snapshot is the durable baseline for full history.
		return this.session.subscribe(event => {
			if (event.type === "message_end") handler(event.message);
		});
	}

	onRunStateChange(handler: (busy: boolean) => void): () => void {
		return this.session.subscribeRunState(state => handler(state === "running"));
	}

	dispose(_reason: string): Promise<void> {
		// Clean C4 stop path: a plain programmatic dispose (records the generic
		// "dispose" exit reason), never a signal postmortem (graft risk #2). The
		// reason string is advisory only; disposal semantics stay OMP's default.
		return this.session.dispose({});
	}
}

/** {@link PromptInjector} over a {@link ResidentSession}. The scheduler's only session touchpoint. */
export class SessionPromptInjector implements PromptInjector {
	constructor(private readonly session: ResidentSession) {}

	async injectPrompt(text: string, options: InjectPromptOptions): Promise<InjectOutcome> {
		if (!this.session.isStreaming()) {
			await this.session.prompt(text);
			return "started";
		}
		if (options.whenBusy === "steer") {
			await this.session.steer(text);
			return "steered";
		}
		await this.session.followUp(text);
		return "queued";
	}

	isBusy(): boolean {
		return this.session.isStreaming();
	}

	activity(): SessionActivity {
		return this.session.activity();
	}
}
