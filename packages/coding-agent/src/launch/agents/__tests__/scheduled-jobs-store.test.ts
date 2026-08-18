import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateScheduledJobInput, JobOutcomeData, ScheduledJobsState } from "../artifacts";
import { SESSION_SCHEDULED_JOBS_FILENAME } from "../artifacts";
import { parseAgentCronSchedule } from "../cron-schedule";
import type { InjectOutcome, InjectPromptOptions, PromptInjector, SessionActivity } from "../prompt-injector";
import { ScheduledJobScheduler, ScheduledJobStore } from "../scheduled-jobs-store";

function tempStoreDir(): string {
	return mkdtempSync(join(tmpdir(), "omp-sched-"));
}

function baseJob(now: Date, overrides: Partial<CreateScheduledJobInput> = {}): CreateScheduledJobInput {
	return {
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session-1.json",
		cwd: "/tmp",
		prompt: "run the check",
		scheduleText: "every 10s",
		now,
		...overrides,
	};
}

function readState(dir: string): ScheduledJobsState {
	return JSON.parse(readFileSync(join(dir, SESSION_SCHEDULED_JOBS_FILENAME), "utf-8")) as ScheduledJobsState;
}

class StubInjector implements PromptInjector {
	calls: Array<{ text: string; options: InjectPromptOptions }> = [];
	outcome: InjectOutcome = "started";
	streaming = false;

	async injectPrompt(text: string, options: InjectPromptOptions): Promise<InjectOutcome> {
		this.calls.push({ text, options });
		return this.outcome;
	}

	isBusy(): boolean {
		return this.streaming;
	}

	activity(): SessionActivity {
		return {
			isStreaming: this.streaming,
			isCompacting: false,
			isRetrying: false,
			isBashRunning: false,
			hasPendingWork: false,
			unfinishedActionCount: 0,
		};
	}
}

describe("ScheduledJobStore.claimDue", () => {
	test("advances nextRunAt + writes dispatch record before returning; completeDispatch removes it", () => {
		const dir = tempStoreDir();
		const store = new ScheduledJobStore(dir);
		const t0 = new Date("2026-01-01T00:00:00.000Z");
		const job = store.create(baseJob(t0));

		const claimAt = new Date(t0.getTime() + 10_000);
		const dispatches = store.claimDue(claimAt);
		expect(dispatches).toHaveLength(1);

		// The tick is already consumed the instant claimDue returns.
		const advanced = store.get(job.id)!;
		expect(new Date(advanced.nextRunAt!).getTime()).toBeGreaterThan(claimAt.getTime());
		expect(advanced.runCount).toBe(1);
		expect(advanced.lastRunAt).toBe(claimAt.toISOString());

		// The dispatch record is durable on disk.
		expect(readState(dir).dispatches).toHaveLength(1);

		store.completeDispatch(dispatches[0]!.id, "ran");
		expect(readState(dir).dispatches).toHaveLength(0);
	});
});

describe("ScheduledJobStore crash recovery", () => {
	test("recoverInterrupted re-arms the job without replaying the uncertain tick", () => {
		const dir = tempStoreDir();
		const store = new ScheduledJobStore(dir);
		const t0 = new Date("2026-01-01T00:00:00.000Z");
		const job = store.create(baseJob(t0));

		const claimAt = new Date(t0.getTime() + 10_000);
		expect(store.claimDue(claimAt)).toHaveLength(1);
		// Simulate a crash between claim and injection: the dispatch record is left behind.
		expect(readState(dir).dispatches).toHaveLength(1);

		// A fresh process opens the same store file and recovers.
		const fresh = new ScheduledJobStore(dir);
		const recovered = fresh.recoverInterrupted(new Date(claimAt.getTime() + 1));
		expect(recovered.map(r => r.id)).toEqual([job.id]);
		expect(readState(dir).dispatches).toHaveLength(0);

		// The uncertain tick is NOT replayed: claimDue at the same `now` returns nothing.
		expect(fresh.claimDue(claimAt)).toHaveLength(0);
		// The job remains armed for a future tick.
		const armed = fresh.get(job.id)!;
		expect(armed.status).toBe("active");
		expect(new Date(armed.nextRunAt!).getTime()).toBeGreaterThan(claimAt.getTime());
	});
});

describe("ScheduledJobScheduler dispatch", () => {
	test("injects a due job while detached and reports outcome 'ran'", async () => {
		const dir = tempStoreDir();
		const store = new ScheduledJobStore(dir);
		const injector = new StubInjector();
		const outcomes: JobOutcomeData[] = [];
		let clock = new Date("2026-01-01T00:00:00.000Z");
		const scheduler = new ScheduledJobScheduler(store, {
			injector,
			onOutcome: o => outcomes.push(o),
			now: () => clock,
		});

		store.create(baseJob(clock, { prompt: "tick!" }));
		clock = new Date(clock.getTime() + 10_000);
		const injected = await scheduler.runDue(clock);
		scheduler.stop();

		expect(injected).toBe(1);
		expect(injector.calls).toHaveLength(1);
		expect(injector.calls[0]!.text).toBe("tick!");
		expect(injector.calls[0]!.options.whenBusy).toBe("steer");
		expect(outcomes.some(o => o.reason === "ran")).toBe(true);
		expect(readState(dir).dispatches).toHaveLength(0);
	});

	test("defers a heartbeat while the session is streaming and reports 'skipped'", async () => {
		const dir = tempStoreDir();
		const store = new ScheduledJobStore(dir);
		const injector = new StubInjector();
		injector.streaming = true;
		const outcomes: JobOutcomeData[] = [];
		let clock = new Date("2026-01-01T00:00:00.000Z");
		const scheduler = new ScheduledJobScheduler(store, {
			injector,
			onOutcome: o => outcomes.push(o),
			now: () => clock,
		});

		store.setHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.json",
			cwd: "/tmp",
			schedule: "every 10s",
			instruction: "pulse",
			deliveryMode: "follow_up",
			now: clock,
		});
		clock = new Date(clock.getTime() + 10_000);
		const injected = await scheduler.runDue(clock);
		scheduler.stop();

		expect(injected).toBe(0);
		expect(injector.calls).toHaveLength(0);
		expect(outcomes.some(o => o.reason === "skipped")).toBe(true);
		expect(readState(dir).dispatches).toHaveLength(0);
	});
});

describe("cron-schedule parsing", () => {
	test("interval literal 'every 5m'", () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		const { schedule, nextRunAt } = parseAgentCronSchedule("every 5m", now);
		expect(schedule.kind).toBe("interval");
		expect(schedule.intervalMs).toBe(300_000);
		expect(nextRunAt.getTime()).toBe(now.getTime() + 300_000);
	});

	test("cron '*/10 * * * *' lands on the next 10-minute boundary", () => {
		const now = new Date("2026-01-01T00:03:00.000Z");
		const { schedule, nextRunAt } = parseAgentCronSchedule("*/10 * * * *", now);
		expect(schedule.kind).toBe("cron");
		expect(schedule.expression).toBe("*/10 * * * *");
		expect(nextRunAt.getTime()).toBeGreaterThan(now.getTime());
		// Minute field is evaluated in local time; a */10 match is a local minute multiple of 10.
		expect(nextRunAt.getMinutes() % 10).toBe(0);
		expect(nextRunAt.getSeconds()).toBe(0);
	});

	test("store persists a created job file", () => {
		const dir = tempStoreDir();
		const store = new ScheduledJobStore(dir);
		store.create(baseJob(new Date("2026-01-01T00:00:00.000Z")));
		expect(existsSync(join(dir, SESSION_SCHEDULED_JOBS_FILENAME))).toBe(true);
		expect(readState(dir).jobs).toHaveLength(1);
	});
});
