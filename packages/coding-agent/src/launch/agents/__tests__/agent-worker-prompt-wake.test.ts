/**
 * Regression: the C4 prompt/steer/follow_up commands must wake an IDLE detached
 * resident worker and start a turn — the whole point of a resident worker is that
 * a prompt fires with no client attached.
 *
 * The gap this guards: a bare `session.followUp` on a fresh idle session only
 * auto-continues from an assistant/toolResult tail, so it enqueues without ever
 * starting a turn (busy stays false, no reply). Routing every prompt variant
 * through the {@link SessionPromptInjector} seam — the same touchpoint the
 * scheduler uses — makes the idle path go through `session.prompt`, which
 * unconditionally starts the turn.
 *
 * Two layers of proof:
 *  - the worker invokes `injector.injectPrompt` with the right `whenBusy` mode
 *    for each command (spy injector), and
 *  - a turn actually starts on the idle path: busy toggles true→false and an
 *    assistant reply streams over the C4 event stream (default injector over a
 *    turn-modeling fake session), including for `follow_up`, the previously
 *    stuck variant. The busy branch still steers.
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AgentWorker, type WorkerScheduling } from "../agent-worker";
import {
	type ActiveSessionId,
	AGENT_CONTROL_PROTOCOL_INFO,
	type AgentAutonomousView,
	type AgentControlCommand,
	type AgentControlCommandEnvelope,
	type AgentGoalView,
	type AgentMessageMode,
	type AgentScheduledJobView,
} from "../control-protocol";
import type { CustomEntryLike, GoalCheckpointData, JobOutcomeData } from "../artifacts";
import type { InjectOutcome, InjectPromptOptions, PromptInjector, SessionActivity } from "../prompt-injector";
import type { ResidentSession } from "../resident-session";
import { type BrokerSideLink, createMemoryLinkPair, type WorkerToBroker } from "../worker-transport";

const SID = "sid-1" as ActiveSessionId;

function assistantText(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as unknown as AgentMessage;
}

function envelope(command: AgentControlCommand, id: string): AgentControlCommandEnvelope {
	return { type: "command", id, protocol: AGENT_CONTROL_PROTOCOL_INFO, clientId: "A", command };
}

async function settle(): Promise<void> {
	// Drain the memory-link queueMicrotask relay deterministically (no wall clock).
	for (let i = 0; i < 64; i++) await Promise.resolve();
}

const EMPTY_GOAL: AgentGoalView = {
	active: false,
	status: "idle",
	tokensUsed: 0,
	timeUsedSeconds: 0,
	continuationsUsed: 0,
};
const EMPTY_AUTONOMOUS: AgentAutonomousView = {
	enabled: false,
	continuationsUsed: 0,
	turnsUsed: 0,
	tokensUsed: 0,
	limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 1_800_000 },
};

class NoopScheduling implements WorkerScheduling {
	start(): void {}
	stop(): void {}
	addJob(): AgentScheduledJobView {
		return { id: "j", source: "cron", kind: "interval", status: "active", prompt: "p", schedule: "5m", runCount: 0 };
	}
	listJobs(): AgentScheduledJobView[] {
		return [];
	}
	cancelJob(): boolean {
		return true;
	}
	setHeartbeat(): AgentScheduledJobView {
		return { id: "h", source: "heartbeat", kind: "interval", status: "active", prompt: "p", schedule: "5m", runCount: 0 };
	}
	pauseHeartbeat(): AgentScheduledJobView | undefined {
		return undefined;
	}
	resumeHeartbeat(): AgentScheduledJobView | undefined {
		return undefined;
	}
	clearHeartbeat(): void {}
	setGoal(): AgentGoalView {
		return EMPTY_GOAL;
	}
	goalStatus(): AgentGoalView {
		return EMPTY_GOAL;
	}
	pauseGoal(): AgentGoalView {
		return EMPTY_GOAL;
	}
	resumeGoal(): AgentGoalView {
		return EMPTY_GOAL;
	}
	clearGoal(): AgentGoalView {
		return EMPTY_GOAL;
	}
	autonomousOn(): AgentAutonomousView {
		return EMPTY_AUTONOMOUS;
	}
	autonomousOff(): AgentAutonomousView {
		return EMPTY_AUTONOMOUS;
	}
	autonomousStatus(): AgentAutonomousView {
		return EMPTY_AUTONOMOUS;
	}
}

/**
 * A resident session that models real turn semantics: `prompt` starts a turn
 * (busy true → assistant reply → busy false); `steer` interrupts with a reply;
 * `followUp` reproduces the fresh-idle wake GAP — it enqueues but only produces a
 * reply when already streaming (mirroring the assistant-tail auto-continue gate).
 */
class WakeModelingSession implements ResidentSession {
	readonly activeSessionId = SID;
	readonly sessionId = SID;
	readonly sessionFile = "/tmp/fake.jsonl";
	readonly cwd = "/tmp";
	readonly calls: string[] = [];
	#streaming = false;
	#messages: AgentMessage[] = [];
	#messageListeners = new Set<(m: AgentMessage) => void>();
	#runStateListeners = new Set<(busy: boolean) => void>();

	#setStreaming(busy: boolean): void {
		this.#streaming = busy;
		for (const l of this.#runStateListeners) l(busy);
	}

	#produce(text: string): void {
		const message = assistantText(text);
		this.#messages.push(message);
		for (const l of this.#messageListeners) l(message);
	}

	isStreaming(): boolean {
		return this.#streaming;
	}

	activity(): SessionActivity {
		return {
			isStreaming: this.#streaming,
			isCompacting: false,
			isRetrying: false,
			isBashRunning: false,
			hasPendingWork: this.#streaming,
			unfinishedActionCount: 0,
		};
	}

	async prompt(text: string): Promise<void> {
		this.calls.push(`prompt:${text}`);
		this.#setStreaming(true);
		this.#produce(`reply:${text}`);
		this.#setStreaming(false);
	}

	async steer(text: string): Promise<void> {
		this.calls.push(`steer:${text}`);
		this.#produce(`steer:${text}`);
	}

	async followUp(text: string): Promise<void> {
		this.calls.push(`followUp:${text}`);
		// Fresh-idle wake gap: enqueue only; a reply is produced solely when a turn
		// is already streaming (the pre-fix behavior the worker must not rely on).
		if (this.#streaming) this.#produce(`followUp:${text}`);
	}

	async deliverMessage(_from: string, _text: string, _mode: AgentMessageMode): Promise<"injected" | "woken"> {
		return "injected";
	}

	getMessages(): AgentMessage[] {
		return [...this.#messages];
	}
	getEntries(): CustomEntryLike[] {
		return [];
	}
	getArtifactsDir(): string | null {
		return "/tmp/fake-artifacts";
	}
	getUsageTotals(): { input: number; output: number } {
		return { input: 0, output: 0 };
	}
	appendGoalCheckpoint(_data: GoalCheckpointData): void {}
	appendJobOutcome(_data: JobOutcomeData): void {}
	onMessage(handler: (m: AgentMessage) => void): () => void {
		this.#messageListeners.add(handler);
		return () => this.#messageListeners.delete(handler);
	}
	onRunStateChange(handler: (busy: boolean) => void): () => void {
		this.#runStateListeners.add(handler);
		return () => this.#runStateListeners.delete(handler);
	}
	async dispose(): Promise<void> {}

	/** Test seam: preset the streaming state before a command (models a busy turn). */
	forceStreaming(busy: boolean): void {
		this.#setStreaming(busy);
	}
}

class SpyInjector implements PromptInjector {
	readonly calls: Array<{ text: string; options: InjectPromptOptions }> = [];
	busy = false;
	async injectPrompt(text: string, options: InjectPromptOptions): Promise<InjectOutcome> {
		this.calls.push({ text, options });
		return this.busy ? (options.whenBusy === "steer" ? "steered" : "queued") : "started";
	}
	isBusy(): boolean {
		return this.busy;
	}
	activity(): SessionActivity {
		return {
			isStreaming: this.busy,
			isCompacting: false,
			isRetrying: false,
			isBashRunning: false,
			hasPendingWork: this.busy,
			unfinishedActionCount: 0,
		};
	}
}

interface Harness {
	broker: BrokerSideLink;
	received: WorkerToBroker[];
	worker: AgentWorker;
	deliver(command: AgentControlCommand, id: string): Promise<void>;
	stop(): Promise<void>;
}

async function startWorker(session: ResidentSession, injector?: PromptInjector): Promise<Harness> {
	const { broker, worker: workerLink } = createMemoryLinkPair();
	const received: WorkerToBroker[] = [];
	broker.onMessage(message => {
		received.push(message);
		if (message.type === "auth") broker.send({ type: "auth_ok", generation: message.generation });
	});
	const worker = new AgentWorker({
		link: workerLink,
		session,
		injector,
		scheduling: new NoopScheduling(),
		entityName: "phi",
		cwd: "/tmp",
		token: "tok",
		generation: "g1",
	});
	void worker.start();
	await settle();
	return {
		broker,
		received,
		worker,
		async deliver(command, id) {
			broker.send({ type: "command", envelope: envelope(command, id) });
			await settle();
		},
		async stop() {
			await worker.stop("test");
		},
	};
}

function resultFor(received: WorkerToBroker[], commandId: string): AgentControlCommand["type"] | undefined {
	const hit = received.find(m => m.type === "result" && m.commandId === commandId);
	return hit && hit.type === "result" ? hit.result.type : undefined;
}

function messageTexts(received: WorkerToBroker[]): string[] {
	const texts: string[] = [];
	for (const m of received) {
		if (m.type !== "event" || m.event.kind !== "message") continue;
		const message = m.event.message;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "text") texts.push(block.text);
		}
	}
	return texts;
}

function busyEvents(received: WorkerToBroker[]): boolean[] {
	return received.flatMap(m => (m.type === "event" && m.event.kind === "status" ? [m.event.busy] : []));
}

describe("AgentWorker C4 prompt delivery routes through the injector seam", () => {
	test("each command invokes injectPrompt with the correct whenBusy mode", async () => {
		const spy = new SpyInjector();
		const h = await startWorker(new WakeModelingSession(), spy);
		try {
			await h.deliver({ type: "prompt", id: SID, text: "P" }, "c1");
			await h.deliver({ type: "steer", id: SID, text: "S" }, "c2");
			await h.deliver({ type: "follow_up", id: SID, text: "F" }, "c3");

			expect(spy.calls).toEqual([
				{ text: "P", options: { whenBusy: "follow_up" } },
				{ text: "S", options: { whenBusy: "steer" } },
				{ text: "F", options: { whenBusy: "follow_up" } },
			]);
			expect(resultFor(h.received, "c1")).toBe("prompt");
			expect(resultFor(h.received, "c2")).toBe("steer");
			expect(resultFor(h.received, "c3")).toBe("follow_up");
		} finally {
			await h.stop();
		}
	});
});

describe("AgentWorker wakes an idle detached session and starts a turn", () => {
	test("idle prompt starts a turn: busy true→false + assistant reply on the event stream", async () => {
		const session = new WakeModelingSession();
		const h = await startWorker(session); // default SessionPromptInjector over the session
		try {
			await h.deliver({ type: "prompt", id: SID, text: "do work" }, "c1");

			expect(session.calls).toContain("prompt:do work");
			expect(messageTexts(h.received)).toContain("reply:do work");
			expect(busyEvents(h.received)).toEqual([true, false]);
			const result = h.received.find(m => m.type === "result" && m.commandId === "c1");
			expect(result && result.type === "result" && result.result.ok).toBe(true);
		} finally {
			await h.stop();
		}
	});

	test("idle follow_up wakes via prompt (regression: no longer stuck enqueued)", async () => {
		const session = new WakeModelingSession();
		const h = await startWorker(session);
		try {
			await h.deliver({ type: "follow_up", id: SID, text: "later" }, "c1");

			// The fix routes idle follow_up through session.prompt (a real wake), not the
			// no-op session.followUp that would leave the turn stuck with busy=false.
			expect(session.calls).toContain("prompt:later");
			expect(session.calls).not.toContain("followUp:later");
			expect(messageTexts(h.received)).toContain("reply:later");
			expect(busyEvents(h.received)).toEqual([true, false]);
		} finally {
			await h.stop();
		}
	});

	test("busy target steers instead of starting a fresh turn", async () => {
		const session = new WakeModelingSession();
		session.forceStreaming(true);
		const h = await startWorker(session);
		try {
			await h.deliver({ type: "steer", id: SID, text: "pivot" }, "c1");

			expect(session.calls).toContain("steer:pivot");
			expect(session.calls.some(c => c.startsWith("prompt:"))).toBe(false);
			expect(messageTexts(h.received)).toContain("steer:pivot");
		} finally {
			await h.stop();
		}
	});
});

/**
 * A session whose idle turn BLOCKS on an external gate, so a test can observe
 * worker behavior mid-turn. `prompt` sets busy=true, then parks until `release()`
 * before producing the reply and clearing busy. This is what makes the
 * accept-fast property observable: with the dev's synchronous WakeModelingSession
 * a turn always completes within the same microtask drain, so a "return the C4
 * result before the turn finishes" bug would be invisible.
 */
class GatedWakeSession implements ResidentSession {
	readonly activeSessionId = SID;
	readonly sessionId = SID;
	readonly sessionFile = "/tmp/fake.jsonl";
	readonly cwd = "/tmp";
	readonly calls: string[] = [];
	#streaming = false;
	#messages: AgentMessage[] = [];
	#messageListeners = new Set<(m: AgentMessage) => void>();
	#runStateListeners = new Set<(busy: boolean) => void>();
	#gate = Promise.withResolvers<void>();

	/** Unblock the parked idle turn. */
	release(): void {
		this.#gate.resolve();
	}

	#setStreaming(busy: boolean): void {
		this.#streaming = busy;
		for (const l of this.#runStateListeners) l(busy);
	}
	#produce(text: string): void {
		const message = assistantText(text);
		this.#messages.push(message);
		for (const l of this.#messageListeners) l(message);
	}

	isStreaming(): boolean {
		return this.#streaming;
	}
	activity(): SessionActivity {
		return {
			isStreaming: this.#streaming,
			isCompacting: false,
			isRetrying: false,
			isBashRunning: false,
			hasPendingWork: this.#streaming,
			unfinishedActionCount: 0,
		};
	}
	async prompt(text: string): Promise<void> {
		this.calls.push(`prompt:${text}`);
		this.#setStreaming(true);
		await this.#gate.promise;
		this.#produce(`reply:${text}`);
		this.#setStreaming(false);
	}
	async steer(text: string): Promise<void> {
		this.calls.push(`steer:${text}`);
		this.#produce(`steer:${text}`);
	}
	async followUp(text: string): Promise<void> {
		this.calls.push(`followUp:${text}`);
		if (this.#streaming) this.#produce(`followUp:${text}`);
	}
	async deliverMessage(): Promise<"injected" | "woken"> {
		return "injected";
	}
	getMessages(): AgentMessage[] {
		return [...this.#messages];
	}
	getEntries(): CustomEntryLike[] {
		return [];
	}
	getArtifactsDir(): string | null {
		return "/tmp/fake-artifacts";
	}
	getUsageTotals(): { input: number; output: number } {
		return { input: 0, output: 0 };
	}
	appendGoalCheckpoint(_data: GoalCheckpointData): void {}
	appendJobOutcome(_data: JobOutcomeData): void {}
	onMessage(handler: (m: AgentMessage) => void): () => void {
		this.#messageListeners.add(handler);
		return () => this.#messageListeners.delete(handler);
	}
	onRunStateChange(handler: (busy: boolean) => void): () => void {
		this.#runStateListeners.add(handler);
		return () => this.#runStateListeners.delete(handler);
	}
	async dispose(): Promise<void> {}
}

describe("AgentWorker preserves the accept-fast control response (adversarial)", () => {
	test("idle prompt: C4 result returns while the turn is still in flight, not after it completes", async () => {
		const session = new GatedWakeSession();
		const h = await startWorker(session); // default SessionPromptInjector
		try {
			await h.deliver({ type: "prompt", id: SID, text: "slow" }, "c1");

			// Turn has started (busy=true emitted, session.prompt entered) but is
			// parked on the gate: no reply, no busy=false yet.
			expect(session.calls).toContain("prompt:slow");
			expect(busyEvents(h.received)).toEqual([true]);
			expect(messageTexts(h.received)).not.toContain("reply:slow");

			// Accept-fast: the control result is ALREADY back even though the turn
			// has not resolved. A block-until-complete regression would withhold it.
			const result = h.received.find(m => m.type === "result" && m.commandId === "c1");
			const control = result?.type === "result" ? result.result : undefined;
			expect(control?.ok).toBe(true);
			expect(control !== undefined && control.ok === true && control.type === "prompt" && control.accepted).toBe(
				true,
			);

			// Now let the turn finish; the reply + busy=false stream afterward.
			session.release();
			await settle();
			expect(messageTexts(h.received)).toContain("reply:slow");
			expect(busyEvents(h.received)).toEqual([true, false]);
		} finally {
			session.release();
			await h.stop();
		}
	});
});

describe("AgentWorker busy-target delivery (adversarial)", () => {
	test("busy prompt queues via follow_up and never starts a second concurrent turn", async () => {
		const session = new WakeModelingSession();
		session.forceStreaming(true); // a turn is already running
		const h = await startWorker(session);
		try {
			await h.deliver({ type: "prompt", id: SID, text: "queued work" }, "c1");

			// prompt maps to whenBusy="follow_up": on a busy session the injector
			// must queue (session.followUp), NEVER call session.prompt again (which
			// would start a second concurrent turn) and NEVER steer/interrupt.
			expect(session.calls).toContain("followUp:queued work");
			expect(session.calls.some(c => c.startsWith("prompt:"))).toBe(false);
			expect(session.calls.some(c => c.startsWith("steer:"))).toBe(false);

			const result = h.received.find(m => m.type === "result" && m.commandId === "c1");
			expect(result && result.type === "result" && result.result.ok).toBe(true);
		} finally {
			await h.stop();
		}
	});

	test("busy follow_up queues (never steers)", async () => {
		const session = new WakeModelingSession();
		session.forceStreaming(true);
		const h = await startWorker(session);
		try {
			await h.deliver({ type: "follow_up", id: SID, text: "defer" }, "c1");

			expect(session.calls).toContain("followUp:defer");
			expect(session.calls.some(c => c.startsWith("steer:"))).toBe(false);
			expect(session.calls.some(c => c.startsWith("prompt:"))).toBe(false);
		} finally {
			await h.stop();
		}
	});
});
