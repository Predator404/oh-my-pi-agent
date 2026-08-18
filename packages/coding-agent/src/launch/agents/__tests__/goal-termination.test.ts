import { describe, expect, test } from "bun:test";
import type { GoalCheckpointData } from "../artifacts";
import { GoalController } from "../goal-controller";
import type { InjectOutcome, InjectPromptOptions, PromptInjector, SessionActivity } from "../prompt-injector";

class StubInjector implements PromptInjector {
	readonly prompts: string[] = [];
	async injectPrompt(text: string, _options: InjectPromptOptions): Promise<InjectOutcome> {
		this.prompts.push(text);
		return "queued";
	}
	isBusy(): boolean {
		return false;
	}
	activity(): SessionActivity {
		return {
			isStreaming: false,
			isCompacting: false,
			isRetrying: false,
			isBashRunning: false,
			hasPendingWork: false,
			unfinishedActionCount: 0,
		};
	}
}

describe("durable goal always terminates", () => {
	test("a budget-less goal stops at the continuation cap, with recordUsage NEVER called", async () => {
		const injector = new StubInjector();
		const persisted: GoalCheckpointData[] = [];
		const goal = new GoalController({ injector, persist: data => void persisted.push(data), maxContinuations: 3 });
		goal.set({ objective: "keep working forever" }); // no tokenBudget

		// Drive many idle transitions WITHOUT ever recording usage — the exact
		// runaway condition the review flagged. It must still terminate.
		for (let i = 0; i < 12; i++) await goal.afterTurn();

		const status = goal.status();
		expect(status.active).toBe(false);
		expect(status.status).toBe("budget_limited");
		expect(status.continuationsUsed).toBe(3);
		// 3 continuation prompts + exactly one terminal wind-down; nothing after.
		expect(injector.prompts).toHaveLength(4);
		expect(persisted.at(-1)?.lastReason).toBe("max_continuations");
	});

	test("a goal stops on the wall-clock cap", async () => {
		const injector = new StubInjector();
		let clock = 1_000;
		const goal = new GoalController({ injector, persist: () => {}, now: () => clock, maxSeconds: 60 });
		goal.set({ objective: "x" });
		clock = 1_000 + 61_000;
		await goal.afterTurn();
		expect(goal.status().status).toBe("budget_limited");
		expect(goal.snapshot().lastReason).toBe("time_limit");
	});

	test("a token budget still stops the goal when usage is recorded", async () => {
		const injector = new StubInjector();
		const goal = new GoalController({ injector, persist: () => {}, maxContinuations: 1000 });
		goal.set({ objective: "bounded", tokenBudget: 100 });
		goal.recordUsage({ input: 80, output: 40 }); // 120 >= 100
		await goal.afterTurn();
		expect(goal.status().status).toBe("budget_limited");
		expect(goal.snapshot().lastReason).toBe("budget_limited");
	});
});
