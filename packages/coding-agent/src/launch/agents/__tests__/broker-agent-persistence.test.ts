import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AgentWorkerSpawner, DaemonBroker } from "../../broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../client";
import { daemonBrokerEndpoint } from "../../paths";
import { AgentDaemonClient } from "../agent-daemon-client";
import type { WorkerSpawnRequest } from "../agent-supervisor";
import { AgentWorker, type WorkerScheduling } from "../agent-worker";
import type { CustomEntryLike, GoalCheckpointData, JobOutcomeData } from "../artifacts";
import type { AgentAutonomousView, AgentGoalView, AgentMessageMode, AgentScheduledJobView } from "../control-protocol";
import type { SessionActivity } from "../prompt-injector";
import type { ResidentSession } from "../resident-session";
import { createMemoryLinkPair } from "../worker-transport";

// ---------------------------------------------------------------------------
// In-memory worker fakes (recipe lifted from detach-reattach.test.ts): let a
// resident worker's whole handshake run in-process, with no subprocess, no
// socket, no model, and no registry — so the REAL DaemonBroker can be exercised
// end-to-end over its real Unix socket while the worker layer stays hermetic.
// ---------------------------------------------------------------------------

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

/**
 * The in-memory replacement for {@link SubprocessWorkerSpawner}. It stands up a
 * live in-process {@link AgentWorker} per spawn (so the supervisor sees a real
 * "ready" handshake) and records whether the broker ever called `killAll()` —
 * the observable signature of the broker tearing down its resident workers.
 */
function makeFakeSpawner(): {
	spawner: AgentWorkerSpawner;
	sessions: Map<string, FakeResidentSession>;
	state: { killAllCount: number };
} {
	const sessions = new Map<string, FakeResidentSession>();
	const state = { killAllCount: 0 };
	const spawner: AgentWorkerSpawner = {
		async spawn(request: WorkerSpawnRequest) {
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
			void agentWorker.start();
			return { link: broker };
		},
		killAll() {
			state.killAllCount++;
			for (const session of sessions.values()) void session.dispose();
		},
	};
	return { spawner, sessions, state };
}

// ---------------------------------------------------------------------------
// Bounded liveness helpers: poll rather than sleep for state transitions so a
// regression fails fast with a clear message instead of hanging the suite.
// ---------------------------------------------------------------------------

function tryConnect(endpoint: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection({ path: endpoint });
	const done = (ok: boolean): void => {
		socket.destroy();
		resolve(ok);
	};
	socket.once("connect", () => done(true));
	socket.once("error", () => done(false));
	return promise;
}

async function waitForEndpoint(endpoint: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await tryConnect(endpoint)) return;
		await Bun.sleep(10);
	}
	throw new Error(`broker endpoint never became connectable: ${endpoint}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function spawnAgent(client: AgentDaemonClient, entityName: string, cwd: string) {
	// The supervisor is wired a couple of awaited lines after the socket starts
	// listening; tolerate the sub-millisecond window without masking real errors.
	for (let attempt = 0; ; attempt++) {
		try {
			return await client.spawn(entityName, cwd);
		} catch (error) {
			if (attempt < 5 && String(error).includes("agent supervisor unavailable")) {
				await Bun.sleep(10);
				continue;
			}
			throw error;
		}
	}
}

describe("broker resident-agent persistence (SPEC §1.1)", () => {
	// Timing constants. idleGraceMs is kept small so the idle window elapses fast;
	// the initial (pre-client) idle window is comfortably longer than the time to
	// connect the first client, and every "wait past grace" window is 3× grace so
	// at least one idle timer is guaranteed to have fired.
	const idleGraceMs = 300;
	const restartBackoffBaseMs = 1_000;
	const pastGraceMs = idleGraceMs * 3 + 200;

	test("resident agent session survives the launching client's exit and is adopted by a new client", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oma-broker-proj-"));
		const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oma-broker-rt-"));
		const projectDir = await fs.realpath(projectRoot);
		const runtimeDir = await fs.realpath(runtimeRoot);
		const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
		await fs.writeFile(path.join(runtimeDir, "broker.token"), token, { mode: 0o600 });

		const { spawner, state } = makeFakeSpawner();
		const broker = new DaemonBroker(projectDir, runtimeDir, token, idleGraceMs, restartBackoffBaseMs, spawner);

		let brokerResolved = false;
		// run() resolves only when the broker fully shuts down. Keep the promise;
		// never await it inline (it would hang the test forever).
		const running = broker
			.run()
			.then(() => {
				brokerResolved = true;
			})
			.catch(() => {
				brokerResolved = true;
			});

		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		let rawA: DaemonBrokerClient | undefined;
		let rawB: DaemonBrokerClient | undefined;
		try {
			await waitForEndpoint(endpoint, 5_000);
			// Let the awaited chmod + supervisor init settle before the first RPC.
			await Bun.sleep(30);

			// Client A: the launching CLI. Spawn a resident "phi" worker.
			rawA = await createDaemonBrokerClient(projectDir, { runtimeDir });
			const clientA = new AgentDaemonClient(rawA);
			const spawned = await spawnAgent(clientA, "phi", projectDir);
			expect(spawned.workerState).toBe("ready");
			const sessionId = spawned.id;

			// The launching CLI exits: drop its socket and wait past the idle grace.
			rawA.close();
			rawA = undefined;
			await Bun.sleep(pastGraceMs);

			// SPEC §1.1: the broker MUST persist and keep the resident worker
			// alive after its launching client disconnects. Today the idle timer
			// is blind to resident agent sessions, so it shuts the broker down and
			// killAll() reaps the worker — these two assertions are the red signal.
			expect(state.killAllCount).toBe(0);
			expect(brokerResolved).toBe(false);

			// A brand-new client adopts the SAME still-live broker: the phi session
			// is still resident and ready — no cold start, no lost worker.
			await waitForEndpoint(endpoint, 2_000);
			rawB = await createDaemonBrokerClient(projectDir, { runtimeDir });
			const clientB = new AgentDaemonClient(rawB);
			const sessions = await clientB.list();
			const survivor = sessions.find(s => s.id === sessionId);
			expect(survivor).toBeDefined();
			expect(survivor?.workerState).toBe("ready");

			// Control: the fix must NOT pin the broker open forever. Once the last
			// resident session is stopped and no client is attached, idle shutdown
			// must still fire and run() must resolve.
			await clientB.stop(sessionId);
			rawB.close();
			rawB = undefined;
			await waitFor(() => brokerResolved, pastGraceMs + 3_000, "idle shutdown once nothing is resident");
			expect(brokerResolved).toBe(true);
		} finally {
			rawA?.close();
			rawB?.close();
			await broker.shutdown();
			await running;
			await fs.rm(projectRoot, { recursive: true, force: true });
			await fs.rm(runtimeRoot, { recursive: true, force: true });
		}
	}, 20_000);
});
