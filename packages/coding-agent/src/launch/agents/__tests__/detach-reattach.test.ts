import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AgentSupervisor, type ClientChannel, type WorkerSpawner } from "../agent-supervisor";
import { AgentWorker, type WorkerScheduling } from "../agent-worker";
import type { CustomEntryLike, GoalCheckpointData, JobOutcomeData } from "../artifacts";
import type { AgentMessageMode } from "../control-protocol";
import {
	type ActiveSessionId,
	AGENT_CONTROL_PROTOCOL_INFO,
	type AgentAutonomousView,
	type AgentClientCapability,
	type AgentControlCommand,
	type AgentControlCommandEnvelope,
	type AgentControlEventEnvelope,
	type AgentGoalView,
	type AgentScheduledJobView,
} from "../control-protocol";
import type { SessionActivity } from "../prompt-injector";
import type { ResidentSession } from "../resident-session";
import { createMemoryLinkPair } from "../worker-transport";

// A test seam: a minimal assistant message. Tests only read role/content/count.
function assistantText(text: string): AgentMessage {
	const message = { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
	return message as unknown as AgentMessage;
}

class FakeResidentSession implements ResidentSession {
	readonly sessionId: string;
	readonly sessionFile = "/tmp/fake-session.jsonl";
	#messages: AgentMessage[] = [];
	#messageListeners = new Set<(m: AgentMessage) => void>();
	#runStateListeners = new Set<(busy: boolean) => void>();
	#streaming = false;
	disposed = false;
	readonly goalCheckpoints: GoalCheckpointData[] = [];
	readonly jobOutcomes: JobOutcomeData[] = [];
	readonly delivered: Array<{ from: string; text: string; mode: AgentMessageMode }> = [];

	constructor(
		readonly activeSessionId: string,
		readonly cwd: string,
	) {
		this.sessionId = activeSessionId;
	}

	/** Simulate a turn producing an assistant message (e.g. a scheduled wake). */
	produce(text: string): void {
		const message = assistantText(text);
		this.#messages.push(message);
		for (const listener of this.#messageListeners) listener(message);
	}

	setStreaming(streaming: boolean): void {
		this.#streaming = streaming;
		for (const listener of this.#runStateListeners) listener(streaming);
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
		this.produce(`reply:${text}`);
	}

	async steer(text: string): Promise<void> {
		this.produce(`steer:${text}`);
	}

	async followUp(text: string): Promise<void> {
		this.produce(`followUp:${text}`);
	}

	async deliverMessage(from: string, text: string, mode: AgentMessageMode): Promise<"injected" | "woken"> {
		this.delivered.push({ from, text, mode });
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

	appendGoalCheckpoint(data: GoalCheckpointData): void {
		this.goalCheckpoints.push(data);
	}

	appendJobOutcome(data: JobOutcomeData): void {
		this.jobOutcomes.push(data);
	}

	onMessage(handler: (message: AgentMessage) => void): () => void {
		this.#messageListeners.add(handler);
		return () => this.#messageListeners.delete(handler);
	}

	onRunStateChange(handler: (busy: boolean) => void): () => void {
		this.#runStateListeners.add(handler);
		return () => this.#runStateListeners.delete(handler);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
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

class FakeScheduling implements WorkerScheduling {
	started = false;
	stopped = false;
	start(): void {
		this.started = true;
	}
	stop(): void {
		this.stopped = true;
	}
	addJob(): AgentScheduledJobView {
		return {
			id: "job-1",
			source: "cron",
			kind: "interval",
			status: "active",
			prompt: "p",
			schedule: "every 5m",
			runCount: 0,
		};
	}
	listJobs(): AgentScheduledJobView[] {
		return [];
	}
	cancelJob(): boolean {
		return true;
	}
	setHeartbeat(): AgentScheduledJobView {
		return {
			id: "hb",
			source: "heartbeat",
			kind: "interval",
			status: "active",
			prompt: "p",
			schedule: "every 5m",
			runCount: 0,
		};
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

class RecordingClient implements ClientChannel {
	readonly capabilities: readonly AgentClientCapability[] = ["attach_snapshot", "event_sequence", "chunked_snapshot"];
	readonly events: AgentControlEventEnvelope[] = [];
	constructor(readonly id: string) {}
	sendEvent(envelope: AgentControlEventEnvelope): void {
		this.events.push(envelope);
	}
}

function envelope(command: AgentControlCommand, clientId: string, id: string): AgentControlCommandEnvelope {
	return { type: "command", id, protocol: AGENT_CONTROL_PROTOCOL_INFO, clientId, command };
}

async function settle(): Promise<void> {
	// Drain the memory-link queueMicrotask relay deterministically (no wall clock).
	for (let i = 0; i < 32; i++) await Promise.resolve();
}

function makeSupervisor(): {
	supervisor: AgentSupervisor;
	sessions: Map<string, FakeResidentSession>;
	workers: AgentWorker[];
} {
	const sessions = new Map<string, FakeResidentSession>();
	const workers: AgentWorker[] = [];
	const spawner: WorkerSpawner = {
		async spawn(request) {
			const { broker, worker } = createMemoryLinkPair();
			const session = new FakeResidentSession(request.activeSessionId, request.cwd);
			sessions.set(request.activeSessionId, session);
			const agentWorker = new AgentWorker({
				link: worker,
				session,
				scheduling: new FakeScheduling(),
				entityName: request.entityName,
				cwd: request.cwd,
				token: request.token,
				generation: request.generation,
			});
			workers.push(agentWorker);
			void agentWorker.start();
			return { link: broker };
		},
	};
	const supervisor = new AgentSupervisor({ spawner, commandTimeoutMs: 3000, handshakeTimeoutMs: 3000 });
	return { supervisor, sessions, workers };
}

describe("detach / reattach round-trip", () => {
	test("session survives detach; a new client reattaches to updated state; events buffer while detached", async () => {
		const { supervisor, sessions } = makeSupervisor();
		const clientA = new RecordingClient("A");

		const spawn = await supervisor.handle(envelope({ type: "spawn", entityName: "phi" }, "A", "c-spawn"), clientA);
		expect(spawn.type).toBe("spawn");
		if (spawn.type !== "spawn" || spawn.ok !== true) throw new Error("spawn failed");
		const id: ActiveSessionId = spawn.id;
		expect(spawn.summary.workerState).toBe("ready");

		const session = sessions.get(id)!;
		session.produce("baseline");
		await settle();

		const attachA = await supervisor.handle(envelope({ type: "attach", id }, "A", "c-attach-a"), clientA);
		expect(attachA.type).toBe("attach");
		if (attachA.type !== "attach" || attachA.ok !== true) throw new Error("attach A failed");
		expect(attachA.result.snapshot.messageCount).toBe(1);

		// Detach A. The worker + session stay live.
		const detachA = await supervisor.handle(envelope({ type: "detach", id }, "A", "c-detach-a"), clientA);
		expect(detachA.ok).toBe(true);
		expect(session.disposed).toBe(false);

		// A scheduled wake fires while nobody is attached: the message is buffered.
		session.produce("while-detached");
		await settle();

		// Reattach with a fresh client: snapshot reflects the message produced while detached.
		const clientB = new RecordingClient("B");
		const attachB = await supervisor.handle(envelope({ type: "attach", id }, "B", "c-attach-b"), clientB);
		if (attachB.type !== "attach" || attachB.ok !== true) throw new Error("attach B failed");
		expect(attachB.result.snapshot.messageCount).toBe(2);

		// Subsequent live events reach the reattached client.
		session.produce("after-reattach");
		await settle();
		const texts = clientB.events
			.filter(e => e.event.kind === "message")
			.map(e => (e.event.kind === "message" ? e.event.message : undefined));
		expect(clientB.events.some(e => e.event.kind === "message")).toBe(true);
		expect(texts.length).toBeGreaterThan(0);

		// Clean stop routes a C4 shutdown → the session disposes.
		const stop = await supervisor.handle(envelope({ type: "stop", id }, "A", "c-stop"), clientA);
		expect(stop.ok).toBe(true);
		await settle();
		expect(session.disposed).toBe(true);
	});

	test("list surfaces the running session; prompt is accepted and routed to the worker", async () => {
		const { supervisor, sessions } = makeSupervisor();
		const client = new RecordingClient("A");
		const spawn = await supervisor.handle(envelope({ type: "spawn", entityName: "phi" }, "A", "s1"), client);
		if (spawn.type !== "spawn" || spawn.ok !== true) throw new Error("spawn failed");
		const id = spawn.id;

		const list = await supervisor.handle(envelope({ type: "list" }, "A", "l1"), client);
		if (list.type !== "list" || list.ok !== true) throw new Error("list failed");
		expect(list.sessions.map(s => s.id)).toContain(id);

		const prompt = await supervisor.handle(envelope({ type: "prompt", id, text: "do work" }, "A", "p1"), client);
		expect(prompt.type).toBe("prompt");
		if (prompt.type !== "prompt" || prompt.ok !== true) throw new Error("prompt failed");
		expect(prompt.accepted).toBe(true);
		await settle();
		expect(
			sessions
				.get(id)!
				.getMessages()
				.some(m => JSON.stringify(m).includes("reply:do work")),
		).toBe(true);
	});

	test("idempotent command journal: a replayed spawn does not spawn twice", async () => {
		const { supervisor } = makeSupervisor();
		const client = new RecordingClient("A");
		const first = await supervisor.handle(envelope({ type: "spawn", entityName: "phi" }, "A", "dup"), client);
		const second = await supervisor.handle(envelope({ type: "spawn", entityName: "phi" }, "A", "dup"), client);
		if (first.type !== "spawn" || first.ok !== true || second.type !== "spawn" || second.ok !== true) {
			throw new Error("spawn failed");
		}
		expect(second.id).toBe(first.id);
		expect(supervisor.listSessions()).toHaveLength(1);
	});
});
