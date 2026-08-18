import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

import { AgentSupervisor, type ClientChannel, type WorkerSpawner } from "../agent-supervisor";
import type { CustomEntryLike, GoalCheckpointData, JobOutcomeData } from "../artifacts";
import { CommandJournal } from "../command-journal";
import {
	AGENT_CONTROL_PROTOCOL_INFO,
	type AgentClientCapability,
	type AgentControlCommand,
	type AgentControlCommandEnvelope,
	type AgentControlEventEnvelope,
} from "../control-protocol";
import type { InjectOutcome, InjectPromptOptions, PromptInjector, SessionActivity } from "../prompt-injector";
import type { ResidentSession } from "../resident-session";
import { ScheduledJobScheduler, ScheduledJobStore } from "../scheduled-jobs-store";
import { ResidentScheduling } from "../worker-scheduling";

/**
 * SPEC §12.1 acceptance probes added by WS1Tester. These close the empirical
 * gaps left by the WS1 dev suites:
 *   (b) a heartbeat actually INJECTS while idle + detached (dev only proved the
 *       defer-while-streaming/skip path);
 *   (b) a durable goal injects a continuation through the real ResidentScheduling
 *       facade on the session's idle transition — the composition wiring
 *       (onRunStateChange -> #afterTurn -> goal -> injector) was untested;
 *   (c) the supervisor reports `command_result_uncertain` for a mutation left
 *       pending by a crash and does NOT re-dispatch it (dev proved the completed
 *       replay path + the journal unit semantics, not the supervisor's uncertain
 *       branch end-to-end).
 * Test code only — no product code is modified.
 */

async function settle(): Promise<void> {
	for (let i = 0; i < 64; i++) await Promise.resolve();
}

// ---- (b) heartbeat injects while idle -------------------------------------

class StubInjector implements PromptInjector {
	readonly calls: Array<{ text: string; options: InjectPromptOptions }> = [];
	streaming = false;
	async injectPrompt(text: string, options: InjectPromptOptions): Promise<InjectOutcome> {
		this.calls.push({ text, options });
		return this.streaming ? "steered" : "started";
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
			hasPendingWork: this.streaming,
			unfinishedActionCount: 0,
		};
	}
}

describe("(b) scheduler injects while detached", () => {
	test("a heartbeat fires (injects) while idle and no client is attached", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-probe-hb-"));
		try {
			const store = new ScheduledJobStore(dir);
			const injector = new StubInjector(); // idle by default
			const outcomes: JobOutcomeData[] = [];
			let clock = new Date("2026-02-01T00:00:00.000Z");
			const scheduler = new ScheduledJobScheduler(store, {
				injector,
				onOutcome: o => outcomes.push(o),
				now: () => clock,
			});

			store.setHeartbeat({
				activeSessionId: "a1",
				sessionId: "s1",
				sessionFile: "/tmp/s1.jsonl",
				cwd: "/tmp",
				schedule: "every 10s",
				instruction: "pulse",
				deliveryMode: "follow_up",
				now: clock,
			});
			clock = new Date(clock.getTime() + 10_000);
			const injected = await scheduler.runDue(clock);
			scheduler.stop();

			expect(injected).toBe(1);
			expect(injector.calls).toHaveLength(1);
			expect(injector.calls[0]!.text).toBe("pulse");
			expect(injector.calls[0]!.options.whenBusy).toBe("follow_up");
			expect(outcomes.some(o => o.reason === "ran")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---- (b) goal continuation through the real facade ------------------------

class RecordingSession implements ResidentSession {
	readonly activeSessionId = "a1";
	readonly sessionId = "s1";
	readonly sessionFile = "/tmp/s1.jsonl";
	readonly cwd = "/tmp";
	readonly calls: Array<{ path: "prompt" | "steer" | "followUp"; text: string }> = [];
	readonly goalCheckpoints: GoalCheckpointData[] = [];
	#streaming = false;
	readonly #runState = new Set<(busy: boolean) => void>();

	constructor(private readonly artifactsDir: string) {}

	/** Simulate a turn settling to idle (the goal continuation trigger). */
	emitRunState(busy: boolean): void {
		this.#streaming = busy;
		for (const listener of this.#runState) listener(busy);
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
		return this.artifactsDir;
	}
	getUsageTotals(): { input: number; output: number } {
		return { input: 0, output: 0 };
	}
	appendGoalCheckpoint(data: GoalCheckpointData): void {
		this.goalCheckpoints.push(data);
	}
	appendJobOutcome(): void {}
	onMessage(): () => void {
		return () => {};
	}
	onRunStateChange(handler: (busy: boolean) => void): () => void {
		this.#runState.add(handler);
		return () => this.#runState.delete(handler);
	}
	async dispose(): Promise<void> {}
}

describe("(b) goal continuation fires while detached, via the real facade", () => {
	test("an active goal injects a continuation on the session's idle transition — no client attached", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-probe-goal-"));
		try {
			const session = new RecordingSession(dir);
			const scheduling = new ResidentScheduling(session);
			scheduling.start();
			scheduling.setGoal({ objective: "keep the build green", tokenBudget: 1_000_000 });

			// A turn runs and settles to idle. No client is ever attached: this is
			// the detached path by construction.
			session.emitRunState(true);
			session.emitRunState(false);
			await settle();
			scheduling.stop();

			expect(session.calls.some(c => c.text.includes("Continue working toward the active thread goal"))).toBe(true);
			// The transition was persisted as a goal checkpoint (C5).
			expect(session.goalCheckpoints.some(c => c.status === "active")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---- (c) supervisor: crash-pending mutation is uncertain, not replayed ----

class RecordingClient implements ClientChannel {
	readonly capabilities: readonly AgentClientCapability[] = [];
	readonly events: AgentControlEventEnvelope[] = [];
	constructor(readonly id: string) {}
	sendEvent(envelope: AgentControlEventEnvelope): void {
		this.events.push(envelope);
	}
}

function envelope(command: AgentControlCommand, clientId: string, id: string): AgentControlCommandEnvelope {
	return { type: "command", id, protocol: AGENT_CONTROL_PROTOCOL_INFO, clientId, command };
}

describe("(c) idempotency: an uncertain mutation is reported, never replayed", () => {
	test("a spawn left pending by a crash comes back uncertain and does NOT re-dispatch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-probe-journal-"));
		const journalPath = join(dir, "commands.jsonl");
		try {
			// A prior process journaled `begin` for this command then died before
			// recording a result — the classic crash-mid-dispatch.
			new CommandJournal(journalPath).begin("clientA", "cmd-crash");

			let spawnCalls = 0;
			const spawner: WorkerSpawner = {
				async spawn() {
					spawnCalls++;
					throw new Error("spawner must not run for an uncertain command");
				},
			};
			const supervisor = new AgentSupervisor({ spawner, journalPath });
			const client = new RecordingClient("clientA");

			const result = await supervisor.handle(
				envelope({ type: "spawn", entityName: "phi" }, "clientA", "cmd-crash"),
				client,
			);

			expect(result.ok).toBe(false);
			if (result.ok !== false) throw new Error("expected an error result");
			expect(result.error.code).toBe("command_result_uncertain");
			expect(spawnCalls).toBe(0);
			expect(supervisor.listSessions()).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
