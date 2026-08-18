import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CustomEntryLike, GoalCheckpointData, JobOutcomeData } from "../artifacts";
import type { SessionActivity } from "../prompt-injector";
import type { ResidentSession } from "../resident-session";
import { SessionPromptInjector } from "../resident-session";

/**
 * Minimal resident session recording which injection path fired. Injection does
 * not depend on client attach state — this is exactly why scheduled/heartbeat/
 * goal prompts fire while detached.
 */
class RecordingSession implements ResidentSession {
	readonly activeSessionId = "s1";
	readonly sessionId = "s1";
	readonly sessionFile = "/tmp/x.jsonl";
	readonly cwd = "/tmp";
	readonly calls: Array<{ path: "prompt" | "steer" | "followUp"; text: string }> = [];
	#streaming: boolean;

	constructor(streaming: boolean) {
		this.#streaming = streaming;
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
		this.calls.push({ path: "prompt", text });
	}
	async steer(text: string): Promise<void> {
		this.calls.push({ path: "steer", text });
	}
	async followUp(text: string): Promise<void> {
		this.calls.push({ path: "followUp", text });
	}
	async deliverMessage(): Promise<"injected" | "woken"> {
		return "injected";
	}
	getMessages(): AgentMessage[] {
		return [];
	}
	getEntries(): CustomEntryLike[] {
		return [];
	}
	getArtifactsDir(): string | null {
		return "/tmp";
	}
	getUsageTotals(): { input: number; output: number } {
		return { input: 0, output: 0 };
	}
	appendGoalCheckpoint(_data: GoalCheckpointData): void {}
	appendJobOutcome(_data: JobOutcomeData): void {}
	onMessage(): () => void {
		return () => {};
	}
	onRunStateChange(): () => void {
		return () => {};
	}
	async dispose(): Promise<void> {}
}

describe("SessionPromptInjector graft boundary", () => {
	test("idle session: injection starts a fresh turn", async () => {
		const session = new RecordingSession(false);
		const injector = new SessionPromptInjector(session);
		const outcome = await injector.injectPrompt("wake up", { whenBusy: "steer" });
		expect(outcome).toBe("started");
		expect(session.calls).toEqual([{ path: "prompt", text: "wake up" }]);
	});

	test("busy session with whenBusy=steer interrupts the current turn", async () => {
		const session = new RecordingSession(true);
		const injector = new SessionPromptInjector(session);
		const outcome = await injector.injectPrompt("urgent", { whenBusy: "steer" });
		expect(outcome).toBe("steered");
		expect(session.calls).toEqual([{ path: "steer", text: "urgent" }]);
	});

	test("busy session with whenBusy=follow_up queues after the current turn", async () => {
		const session = new RecordingSession(true);
		const injector = new SessionPromptInjector(session);
		const outcome = await injector.injectPrompt("later", { whenBusy: "follow_up" });
		expect(outcome).toBe("queued");
		expect(session.calls).toEqual([{ path: "followUp", text: "later" }]);
	});

	test("isBusy reflects the session streaming state", () => {
		expect(new SessionPromptInjector(new RecordingSession(true)).isBusy()).toBe(true);
		expect(new SessionPromptInjector(new RecordingSession(false)).isBusy()).toBe(false);
	});
});
