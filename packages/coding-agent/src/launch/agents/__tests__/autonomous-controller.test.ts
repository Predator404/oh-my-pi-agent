import { describe, expect, test } from "bun:test";
import { AutonomousController } from "../autonomous-controller";
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

describe("AutonomousController", () => {
	test("continues within limits then stops at maxContinuations", async () => {
		const injector = new StubInjector();
		const auto = new AutonomousController({ injector, now: () => 1000 });
		auto.on({ maxContinuations: 1 });
		expect(auto.status().enabled).toBe(true);
		expect(auto.status().limits.maxContinuations).toBe(1);

		const first = await auto.afterTurn({ stopReason: "stop" });
		expect(first).toBe(true);
		expect(injector.calls).toHaveLength(1);
		expect(injector.calls[0]!.options.whenBusy).toBe("follow_up");
		expect(auto.status().continuationsUsed).toBe(1);

		const second = await auto.afterTurn({ stopReason: "stop" });
		expect(second).toBe(false);
		expect(injector.calls).toHaveLength(1);
	});

	test("does not continue on an error stop reason", async () => {
		const injector = new StubInjector();
		const auto = new AutonomousController({ injector });
		auto.on();
		expect(await auto.afterTurn({ stopReason: "error" })).toBe(false);
		expect(injector.calls).toHaveLength(0);
	});

	test("off() disables and afterTurn no-ops", async () => {
		const injector = new StubInjector();
		const auto = new AutonomousController({ injector });
		auto.on();
		auto.off();
		expect(auto.status().enabled).toBe(false);
		expect(await auto.afterTurn({ stopReason: "stop" })).toBe(false);
		expect(injector.calls).toHaveLength(0);
	});
});
