import { describe, expect, test } from "bun:test";
import type { GoalCheckpointData } from "../artifacts";
import { GoalController } from "../goal-controller";
import type { InjectOutcome, InjectPromptOptions, PromptInjector, SessionActivity } from "../prompt-injector";

class StubInjector implements PromptInjector {
	calls: Array<{ text: string; options: InjectPromptOptions }> = [];

	async injectPrompt(text: string, options: InjectPromptOptions): Promise<InjectOutcome> {
		this.calls.push({ text, options });
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

describe("GoalController budget", () => {
	test("stops with a single budget-limit prompt once the token budget is spent", async () => {
		const injector = new StubInjector();
		const persisted: GoalCheckpointData[] = [];
		const goal = new GoalController({
			injector,
			persist: data => {
				persisted.push(data);
			},
			now: () => 1000,
		});

		goal.set({ objective: "finish the migration", tokenBudget: 100 });
		expect(goal.status().status).toBe("active");

		// Within budget: afterTurn injects an ordinary continuation as follow_up.
		goal.recordUsage({ input: 20, output: 10 });
		await goal.afterTurn();
		expect(injector.calls).toHaveLength(1);
		expect(injector.calls[0]!.options.whenBusy).toBe("follow_up");
		expect(injector.calls[0]!.text).toContain("Continue working toward the active thread goal");
		expect(goal.status().continuationsUsed).toBe(1);

		// Exceed the budget, then afterTurn transitions to budget_limited + one wind-down prompt.
		goal.recordUsage({ input: 60, output: 30 });
		await goal.afterTurn();
		expect(goal.status().status).toBe("budget_limited");
		expect(goal.status().active).toBe(false);
		expect(injector.calls).toHaveLength(2);
		expect(injector.calls[1]!.text).toContain("status: budget_limited");

		// The persist hook received the terminal state.
		expect(persisted.at(-1)!.status).toBe("budget_limited");

		// No further continuation is injected after the budget-limit prompt.
		await goal.afterTurn();
		expect(injector.calls).toHaveLength(2);
	});

	test("rejects an over-long objective", () => {
		const injector = new StubInjector();
		const goal = new GoalController({ injector, persist: () => {} });
		expect(() => goal.set({ objective: "x".repeat(4001) })).toThrow(/at most 4000 characters/);
	});
});
