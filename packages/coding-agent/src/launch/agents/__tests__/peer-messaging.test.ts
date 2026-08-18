import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

import type { AgentSession } from "../../../session/agent-session";
import { AgentSupervisor, type ClientChannel, type WorkerSpawner } from "../agent-supervisor";
import { AgentWorker, type WorkerScheduling } from "../agent-worker";
import type { CustomEntryLike, GoalCheckpointData, JobOutcomeData } from "../artifacts";
import {
	AGENT_CONTROL_PROTOCOL_INFO,
	type AgentAutonomousView,
	type AgentControlCommand,
	type AgentControlCommandEnvelope,
	type AgentGoalView,
	type AgentMessageMode,
	type AgentMessageReceipt,
	type AgentScheduledJobView,
	type AgentSessionSummary,
} from "../control-protocol";
import {
	formatPeerFollowUp,
	type PeerMessagingClient,
	PeerMessenger,
	peerReceiptStatus,
	planPeerDelivery,
} from "../peer-messaging";
import type { SessionActivity } from "../prompt-injector";
import { AgentSessionResidentSession, type ResidentSession } from "../resident-session";
import { createMemoryLinkPair } from "../worker-transport";

// ---------------------------------------------------------------------------
// planPeerDelivery — the SPEC §4.4 delivery-mode truth table.
// ---------------------------------------------------------------------------

describe("planPeerDelivery (delivery modes)", () => {
	test("auto steers a busy target and delivers to an idle one", () => {
		expect(planPeerDelivery("auto", true)).toEqual({
			action: "interrupt",
			outcome: "injected",
			status: "delivered",
			expectsReply: false,
		});
		expect(planPeerDelivery("auto", false)).toEqual({
			action: "wake",
			outcome: "woken",
			status: "delivered",
			expectsReply: false,
		});
	});

	test("steer injects into active work (busy) and starts a turn (idle), always expecting a reply", () => {
		expect(planPeerDelivery("steer", true)).toEqual({
			action: "interrupt",
			outcome: "injected",
			status: "delivered",
			expectsReply: true,
		});
		expect(planPeerDelivery("steer", false)).toEqual({
			action: "wake",
			outcome: "woken",
			status: "delivered",
			expectsReply: true,
		});
	});

	test("follow_up queues behind a busy turn but wakes an idle target", () => {
		expect(planPeerDelivery("follow_up", true)).toEqual({
			action: "follow_up",
			outcome: "queued",
			status: "queued",
			expectsReply: true,
		});
		expect(planPeerDelivery("follow_up", false)).toEqual({
			action: "wake",
			outcome: "woken",
			status: "delivered",
			expectsReply: true,
		});
	});

	test("queued is reachable ONLY via follow_up into a busy target", () => {
		const modes: AgentMessageMode[] = ["auto", "steer", "follow_up"];
		const queued = modes
			.flatMap(mode => [true, false].map(busy => ({ mode, busy, plan: planPeerDelivery(mode, busy) })))
			.filter(row => row.plan.status === "queued");
		expect(queued).toEqual([{ mode: "follow_up", busy: true, plan: planPeerDelivery("follow_up", true) }]);
	});
});

// ---------------------------------------------------------------------------
// peerReceiptStatus — delivered vs queued vs failed classification.
// ---------------------------------------------------------------------------

describe("peerReceiptStatus (receipt semantics)", () => {
	const receipt = (outcome: AgentMessageReceipt["outcome"]): AgentMessageReceipt => ({
		target: "b",
		outcome,
		mode: "auto",
	});
	test("injected / woken / revived are all delivered", () => {
		expect(peerReceiptStatus(receipt("injected"))).toBe("delivered");
		expect(peerReceiptStatus(receipt("woken"))).toBe("delivered");
		expect(peerReceiptStatus(receipt("revived"))).toBe("delivered");
	});
	test("queued and failed are reported distinctly", () => {
		expect(peerReceiptStatus(receipt("queued"))).toBe("queued");
		expect(peerReceiptStatus(receipt("failed"))).toBe("failed");
	});
});

// ---------------------------------------------------------------------------
// AgentSessionResidentSession.deliverMessage — real product-code dispatch.
// ---------------------------------------------------------------------------

interface StubSessionCalls {
	followUp: string[];
	irc: Array<{ body: string; from: string; expectsReply: boolean | undefined }>;
}

function makeStubResident(streaming: { value: boolean }): { resident: ResidentSession; calls: StubSessionCalls } {
	const calls: StubSessionCalls = { followUp: [], irc: [] };
	const session = {
		get isStreaming(): boolean {
			return streaming.value;
		},
		async deliverIrcMessage(
			msg: { from: string; body: string },
			opts?: { expectsReply?: boolean },
		): Promise<"injected" | "woken"> {
			calls.irc.push({ body: msg.body, from: msg.from, expectsReply: opts?.expectsReply });
			return streaming.value ? "injected" : "woken";
		},
		async followUp(text: string): Promise<void> {
			calls.followUp.push(text);
		},
	};
	return { resident: new AgentSessionResidentSession(session as unknown as AgentSession, "b1"), calls };
}

describe("AgentSessionResidentSession.deliverMessage (mode-aware dispatch)", () => {
	test("follow_up into a busy session queues via followUp() and reports queued", async () => {
		const streaming = { value: true };
		const { resident, calls } = makeStubResident(streaming);
		const outcome = await resident.deliverMessage("phi", "look at this", "follow_up");
		expect(outcome).toBe("queued");
		expect(calls.followUp).toEqual([formatPeerFollowUp("phi", "look at this")]);
		expect(calls.irc).toHaveLength(0);
	});

	test("auto into a busy session interrupts via IRC (no reply expected) -> injected", async () => {
		const { resident, calls } = makeStubResident({ value: true });
		const outcome = await resident.deliverMessage("phi", "fyi", "auto");
		expect(outcome).toBe("injected");
		expect(calls.irc).toEqual([{ body: "fyi", from: "phi", expectsReply: false }]);
	});

	test("steer into a busy session interrupts via IRC expecting a reply -> injected", async () => {
		const { resident, calls } = makeStubResident({ value: true });
		const outcome = await resident.deliverMessage("phi", "stop and do X", "steer");
		expect(outcome).toBe("injected");
		expect(calls.irc).toEqual([{ body: "stop and do X", from: "phi", expectsReply: true }]);
	});

	test("any mode into an idle session wakes a fresh turn -> woken", async () => {
		for (const mode of ["auto", "steer", "follow_up"] as AgentMessageMode[]) {
			const { resident, calls } = makeStubResident({ value: false });
			const outcome = await resident.deliverMessage("phi", "hi", mode);
			expect(outcome).toBe("woken");
			expect(calls.followUp).toHaveLength(0);
			expect(calls.irc).toHaveLength(1);
		}
	});
});

// ---------------------------------------------------------------------------
// PeerMessenger — roster addressing + broadcast scoping (unit, fake client).
// ---------------------------------------------------------------------------

function summary(id: string, entityName: string, busy = false): AgentSessionSummary {
	return { id, entityName, cwd: "/tmp", workerState: "ready", attached: false, busy, createdAt: "t" };
}

class FakeClient implements PeerMessagingClient {
	readonly sent: Array<{ target: string; text: string; mode: AgentMessageMode; from?: string }> = [];
	constructor(private readonly sessions: AgentSessionSummary[]) {}
	async list(): Promise<AgentSessionSummary[]> {
		return this.sessions;
	}
	async sendMessage(
		target: string,
		text: string,
		mode: AgentMessageMode = "auto",
		from?: string,
	): Promise<AgentMessageReceipt> {
		this.sent.push({ target, text, mode, from });
		return { target, outcome: "woken", mode };
	}
}

describe("PeerMessenger", () => {
	test("roster maps every session the supervisor reports", async () => {
		const client = new FakeClient([summary("id-a", "aria", true), summary("id-b", "phi")]);
		const messenger = new PeerMessenger(client);
		expect(await messenger.roster()).toEqual([
			{ id: "id-a", entityName: "aria", busy: true, attached: false },
			{ id: "id-b", entityName: "phi", busy: false, attached: false },
		]);
	});

	test("send delegates to the client's send_message with target/mode/from intact", async () => {
		const client = new FakeClient([]);
		const messenger = new PeerMessenger(client);
		await messenger.send("phi", "hello", "steer", "aria");
		expect(client.sent).toEqual([{ target: "phi", text: "hello", mode: "steer", from: "aria" }]);
	});

	test("broadcast reaches the roster only and excludes the sender (by name or id)", async () => {
		const client = new FakeClient([summary("id-a", "aria"), summary("id-b", "phi"), summary("id-c", "milo")]);
		const messenger = new PeerMessenger(client);
		const result = await messenger.broadcast("standup", "auto", "aria");
		expect(result.scope).toBe("roster");
		expect(result.recipients.map(r => r.entityName)).toEqual(["phi", "milo"]);
		// Delivered to exactly the two non-sender roster members, addressed by their ids.
		expect(client.sent.map(s => s.target)).toEqual(["id-b", "id-c"]);
		expect(result.receipts).toHaveLength(2);
		// Sender excluded whether referenced by id or by entity name.
		const byId = new FakeClient([summary("id-a", "aria"), summary("id-b", "phi")]);
		await new PeerMessenger(byId).broadcast("x", "auto", "id-a");
		expect(byId.sent.map(s => s.target)).toEqual(["id-b"]);
	});

	test("broadcast with no sender addresses the whole roster", async () => {
		const client = new FakeClient([summary("id-a", "aria"), summary("id-b", "phi")]);
		await new PeerMessenger(client).broadcast("all-hands");
		expect(client.sent.map(s => s.target)).toEqual(["id-a", "id-b"]);
	});
});

// ---------------------------------------------------------------------------
// End-to-end: supervisor -> worker -> resident session over the memory link.
// Proves detached-target delivery, receipt classification, and roster-scoped
// broadcast through the REAL supervisor routing + worker dispatch.
// ---------------------------------------------------------------------------

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
	limits: { maxContinuations: 0, maxTurns: 0, maxTokens: 0, timeoutMs: 0 },
};

/** Mode-aware fake session: classifies delivery via the same planner as production. */
class PeerFakeSession implements ResidentSession {
	readonly sessionId: string;
	readonly sessionFile = "/tmp/peer-fake.jsonl";
	readonly delivered: Array<{ from: string; text: string; mode: AgentMessageMode; outcome: string }> = [];
	#streaming = false;

	constructor(
		readonly activeSessionId: string,
		readonly cwd: string,
	) {
		this.sessionId = activeSessionId;
	}

	setStreaming(streaming: boolean): void {
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
	async prompt(): Promise<void> {}
	async steer(): Promise<void> {}
	async followUp(): Promise<void> {}
	async deliverMessage(from: string, text: string, mode: AgentMessageMode): Promise<AgentMessageReceipt["outcome"]> {
		const outcome = planPeerDelivery(mode, this.#streaming).outcome;
		this.delivered.push({ from, text, mode, outcome });
		return outcome;
	}
	getMessages(): AgentMessage[] {
		return [];
	}
	getEntries(): CustomEntryLike[] {
		return [];
	}
	getArtifactsDir(): string | null {
		return null;
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

class NoopScheduling implements WorkerScheduling {
	start(): void {}
	stop(): void {}
	addJob(): AgentScheduledJobView {
		return {
			id: "j",
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
	pauseHeartbeat(): undefined {
		return undefined;
	}
	resumeHeartbeat(): undefined {
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

const NOOP_CLIENT: ClientChannel = { id: "peer-driver", capabilities: [], sendEvent() {} };

function commandEnvelope(command: AgentControlCommand): AgentControlCommandEnvelope {
	return {
		type: "command",
		id: crypto.randomUUID(),
		protocol: AGENT_CONTROL_PROTOCOL_INFO,
		clientId: "peer-driver",
		command,
	};
}

/** Adapts an AgentSupervisor into the PeerMessagingClient surface (what a broker client gives WS7). */
class SupervisorPeerClient implements PeerMessagingClient {
	constructor(private readonly supervisor: AgentSupervisor) {}
	async list(): Promise<AgentSessionSummary[]> {
		return this.supervisor.listSessions();
	}
	async sendMessage(
		target: string,
		text: string,
		mode: AgentMessageMode = "auto",
		from?: string,
	): Promise<AgentMessageReceipt> {
		const result = await this.supervisor.handle(
			commandEnvelope({ type: "send_message", target, text, mode, from }),
			NOOP_CLIENT,
		);
		if (result.type === "send_message" && result.ok) return result.receipt;
		throw new Error(`send_message failed: ${result.type}`);
	}
}

async function settle(): Promise<void> {
	for (let i = 0; i < 32; i++) await Promise.resolve();
}

function makeHarness(): { supervisor: AgentSupervisor; sessions: Map<string, PeerFakeSession> } {
	const sessions = new Map<string, PeerFakeSession>();
	const spawner: WorkerSpawner = {
		async spawn(request) {
			const { broker, worker } = createMemoryLinkPair();
			const session = new PeerFakeSession(request.activeSessionId, request.cwd);
			sessions.set(request.activeSessionId, session);
			const agentWorker = new AgentWorker({
				link: worker,
				session,
				scheduling: new NoopScheduling(),
				entityName: request.entityName,
				cwd: request.cwd,
				token: request.token,
				generation: request.generation,
			});
			void agentWorker.start();
			return { link: broker };
		},
	};
	return { supervisor: new AgentSupervisor({ spawner, commandTimeoutMs: 3000, handshakeTimeoutMs: 3000 }), sessions };
}

describe("peer delivery end-to-end (detached targets, over the supervisor)", () => {
	test("A steers/queues to B while B is detached; receipts reflect delivered vs queued", async () => {
		const { supervisor, sessions } = makeHarness();
		// B is spawned but never attached -> detached (resident worker is the sink).
		const a = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: "aria" }), NOOP_CLIENT);
		const b = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: "phi" }), NOOP_CLIENT);
		if (a.type !== "spawn" || !a.ok || b.type !== "spawn" || !b.ok) throw new Error("spawn failed");
		await settle();
		const bSession = sessions.get(b.id)!;
		const messenger = new PeerMessenger(new SupervisorPeerClient(supervisor));

		// B busy: steer is delivered (interrupt), follow_up is queued.
		bSession.setStreaming(true);
		const steerReceipt = await messenger.send("phi", "handle the build break", "steer", "aria");
		expect(steerReceipt.outcome).toBe("injected");
		expect(peerReceiptStatus(steerReceipt)).toBe("delivered");

		const followUpReceipt = await messenger.send("phi", "then update the changelog", "follow_up", "aria");
		expect(followUpReceipt.outcome).toBe("queued");
		expect(peerReceiptStatus(followUpReceipt)).toBe("queued");

		// B idle: auto delivers (wakes a fresh turn).
		bSession.setStreaming(false);
		const autoReceipt = await messenger.send("phi", "status?", "auto", "aria");
		expect(autoReceipt.outcome).toBe("woken");
		expect(peerReceiptStatus(autoReceipt)).toBe("delivered");

		// All three landed in the detached target's session, in order.
		expect(bSession.delivered.map(d => [d.mode, d.outcome])).toEqual([
			["steer", "injected"],
			["follow_up", "queued"],
			["auto", "woken"],
		]);
	});

	test("addressing works by entity name and by active-session id", async () => {
		const { supervisor, sessions } = makeHarness();
		const b = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: "phi" }), NOOP_CLIENT);
		if (b.type !== "spawn" || !b.ok) throw new Error("spawn failed");
		await settle();
		const messenger = new PeerMessenger(new SupervisorPeerClient(supervisor));

		const byName = await messenger.send("phi", "by name", "auto");
		const byId = await messenger.send(b.id, "by id", "auto");
		expect(byName.outcome).toBe("woken");
		expect(byId.outcome).toBe("woken");
		expect(sessions.get(b.id)!.delivered.map(d => d.text)).toEqual(["by name", "by id"]);
	});

	test("unknown target returns a failed receipt (never throws)", async () => {
		const { supervisor } = makeHarness();
		const messenger = new PeerMessenger(new SupervisorPeerClient(supervisor));
		const receipt = await messenger.send("ghost", "anyone?", "auto");
		expect(receipt.outcome).toBe("failed");
		expect(peerReceiptStatus(receipt)).toBe("failed");
	});

	test("broadcast reaches the roster only and never echoes to the sender", async () => {
		const { supervisor, sessions } = makeHarness();
		const a = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: "aria" }), NOOP_CLIENT);
		const b = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: "phi" }), NOOP_CLIENT);
		const c = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: "milo" }), NOOP_CLIENT);
		if (a.type !== "spawn" || !a.ok || b.type !== "spawn" || !b.ok || c.type !== "spawn" || !c.ok)
			throw new Error("spawn failed");
		await settle();
		const messenger = new PeerMessenger(new SupervisorPeerClient(supervisor));

		const result = await messenger.broadcast("all-hands at 3", "auto", "aria");
		// Reached exactly the two non-sender roster members.
		// Recipients are roster order (spawn order) minus the sender: deterministic.
		expect(result.recipients.map(r => r.entityName)).toEqual(["phi", "milo"]);
		expect(result.receipts.every(r => r.outcome === "woken")).toBe(true);
		// Sender's own session got nothing; every other roster member got exactly one message.
		expect(sessions.get(a.id)!.delivered).toHaveLength(0);
		expect(sessions.get(b.id)!.delivered.map(d => d.text)).toEqual(["all-hands at 3"]);
		expect(sessions.get(c.id)!.delivered.map(d => d.text)).toEqual(["all-hands at 3"]);
	});

	test("broadcast classifies per-member receipts under mixed busy/idle targets (follow_up)", async () => {
		const { supervisor, sessions } = makeHarness();
		const a = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: "aria" }), NOOP_CLIENT);
		const b = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: "phi" }), NOOP_CLIENT);
		const c = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: "milo" }), NOOP_CLIENT);
		if (a.type !== "spawn" || !a.ok || b.type !== "spawn" || !b.ok || c.type !== "spawn" || !c.ok)
			throw new Error("spawn failed");
		await settle();
		// phi busy, milo idle. follow_up => busy member queues, idle member wakes.
		sessions.get(b.id)!.setStreaming(true);
		sessions.get(c.id)!.setStreaming(false);
		const messenger = new PeerMessenger(new SupervisorPeerClient(supervisor));

		const result = await messenger.broadcast("ship it", "follow_up", "aria");
		// Recipients are roster order (spawn order) minus sender: [phi (busy), milo (idle)].
		expect(result.recipients.map(r => r.entityName)).toEqual(["phi", "milo"]);
		expect(result.receipts.map(peerReceiptStatus)).toEqual(["queued", "delivered"]);
		expect(result.receipts.map(r => r.outcome)).toEqual(["queued", "woken"]);
	});

	test("broadcast over an empty roster is a no-op that never throws", async () => {
		const { supervisor } = makeHarness();
		const messenger = new PeerMessenger(new SupervisorPeerClient(supervisor));
		const result = await messenger.broadcast("anyone?", "auto", "aria");
		expect(result.scope).toBe("roster");
		expect(result.recipients).toEqual([]);
		expect(result.receipts).toEqual([]);
	});

	test("broadcast with sole member being the sender delivers to nobody", async () => {
		const { supervisor } = makeHarness();
		const a = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: "aria" }), NOOP_CLIENT);
		if (a.type !== "spawn" || !a.ok) throw new Error("spawn failed");
		await settle();
		const messenger = new PeerMessenger(new SupervisorPeerClient(supervisor));
		const result = await messenger.broadcast("solo", "auto", "aria");
		expect(result.recipients).toEqual([]);
		expect(result.receipts).toEqual([]);
	});
});
