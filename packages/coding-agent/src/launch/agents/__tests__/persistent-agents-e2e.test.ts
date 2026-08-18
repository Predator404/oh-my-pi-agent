/**
 * Whole-solution end-to-end integration (SPEC §12.9).
 *
 * This is the integration-stage test: it wires the REAL modules from every
 * workstream across their frozen seams (C1–C5) in one scenario, with injected
 * fakes ONLY at the model/AgentSession boundary (a fake resident session, a
 * fake embedder, a stub prompt-injector) — exactly the boundary the per-WS
 * suites already fake. Nothing here contacts a model or the network.
 *
 * Scenario legs (SPEC §12.9 acceptance), each its own test so a seam that fails
 * to compose is reported in isolation:
 *   (a) WS7a setup scaffolds registry + vault sections + a ~/vault symlink.
 *   (b) WS2 resolves two registry entities (agent + persona) to launch configs.
 *   (c) WS3 memory: the agent bank accepts auto-retain, the persona bank rejects
 *       it, recall is bank-scoped — policy resolved from the SAME registry.
 *   (d) WS4 vault: section-scoped write_note + search_notes round-trip, no leak.
 *   (e) WS5 peer: entity A delivers to detached entity B over the REAL
 *       supervisor→worker→resident routing with a correct receipt.
 *   (f) WS6 pointer: a generated stub resolves @~/vault/... through the setup
 *       symlink at skill-read time.
 *   (g) WS1 scheduler: a budget-less goal terminates at the continuation cap.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// --- WS1 daemon + WS5 peer (relative: launch/agents internals, no export) ----
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { expandAtImports } from "@oh-my-pi/pi-coding-agent/discovery/at-imports";
// --- WS2 entity registry (C1) ------------------------------------------------
import {
	EntityValidationError,
	resolveEntityConfig,
	runEntitySetup,
	VAULT_SECTION_DIRS,
} from "@oh-my-pi/pi-coding-agent/entity";
import { buildSkillPromptMessage, type Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { callTool, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
// --- WS3 memory MCP (C2) -----------------------------------------------------
import { BankStore } from "@oh-my-pi/pi-coding-agent/memory-mcp/bank-store";
import { BankPolicyRegistry } from "@oh-my-pi/pi-coding-agent/memory-mcp/policy";
import { handleToolCall as memHandle, RetentionPolicyError } from "@oh-my-pi/pi-coding-agent/memory-mcp/tools";
// --- WS6 project pointer -----------------------------------------------------
import { generateProjectPointerForEntity, projectPointerImport } from "@oh-my-pi/pi-coding-agent/project-pointer";
// --- WS4 vault MCP (C3) ------------------------------------------------------
import { type Embedder, VaultBridge, handleToolCall as vaultHandle } from "@oh-my-pi/pi-coding-agent/vault-mcp";
import { AgentSupervisor, type ClientChannel, type WorkerSpawner } from "../agent-supervisor";
import { AgentWorker, type WorkerScheduling } from "../agent-worker";
import { buildEntityMcpManager } from "../agent-worker-main";
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
import { GoalController } from "../goal-controller";
import { type PeerMessagingClient, PeerMessenger, peerReceiptStatus, planPeerDelivery } from "../peer-messaging";
import type { InjectOutcome, InjectPromptOptions, PromptInjector, SessionActivity } from "../prompt-injector";
import type { ResidentSession } from "../resident-session";
import { createMemoryLinkPair } from "../worker-transport";

// ===========================================================================
// Shared fixture: one temp home, one setup run, two registry entities.
// ===========================================================================

const AGENT_NAME = "atlas"; // role: agent — episodic, auto-retaining.
const PERSONA_NAME = "phi"; // role: persona — curated-only.
const AGENT_BANK = "atlas-bank";
const PERSONA_BANK = "phi-bank";
const AGENT_SECTION = `agents/${AGENT_NAME}`;
const PERSONA_SECTION = `personas/${PERSONA_NAME}`;

const AGENT_RECORD = `---
name: ${AGENT_NAME}
description: Generalist coordinator entity (episodic, auto-retaining).
role: agent
model:
  - anthropic/claude-sonnet-4
memory:
  backend: mnemopi
  bank: ${AGENT_BANK}
  autoRetain: true
vaultSection: ${AGENT_SECTION}
---
Atlas coordinates work and retains episodic memory across sessions.
`;

const PERSONA_RECORD = `---
name: ${PERSONA_NAME}
description: OMP-expert persona (curated domain lessons only).
role: persona
memory:
  backend: mnemopi
  bank: ${PERSONA_BANK}
  autoRetain: false
vaultSection: ${PERSONA_SECTION}
---
Phi is a narrow-domain persona; it curates lessons deliberately.
`;

let root: string;
let home: string;
let agentDir: string;
let registrySource: string;
let registryRoot: string;
let vaultLocation: string;

beforeAll(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-e2e-"));
	home = path.join(root, "home");
	agentDir = path.join(root, "agent");
	registrySource = path.join(root, "registry-checkout");
	await fsp.mkdir(home, { recursive: true });
	await fsp.mkdir(agentDir, { recursive: true });
	await fsp.mkdir(registrySource, { recursive: true });

	const report = await runEntitySetup({
		registrySource,
		homeDir: home,
		agentDir,
		modelsConfigPath: path.join(agentDir, "models.yml"),
	});
	if (!report.ok) throw new Error(`setup failed: ${JSON.stringify(report.steps)}`);
	registryRoot = report.registryRoot;
	vaultLocation = report.vaultLocation;

	// Two entities land in the scaffolded registry (adding an entity = no code change).
	const entitiesDir = path.join(registryRoot, "entities");
	await fsp.writeFile(path.join(entitiesDir, `${AGENT_NAME}.md`), AGENT_RECORD);
	await fsp.writeFile(path.join(entitiesDir, `${PERSONA_NAME}.md`), PERSONA_RECORD);
});

afterAll(async () => {
	if (root) await fsp.rm(root, { recursive: true, force: true });
});

// ===========================================================================
// (a) WS7a — setup scaffolds registry + vault sections + ~/vault symlink.
// ===========================================================================

describe("(a) WS7a setup — registry, vault sections, ~/vault symlink", () => {
	test("a single setup run yields a resolvable ~/vault and a loadable registry", async () => {
		// Registry root is the checkout; wired via <agentDir>/registry symlink.
		expect(registryRoot).toBe(path.resolve(registrySource));
		expect(path.resolve(await fsp.readlink(path.join(agentDir, "registry")))).toBe(path.resolve(registrySource));
		expect((await fsp.stat(path.join(registryRoot, "entities"))).isDirectory()).toBe(true);

		// All vault sections scaffolded under the real vault location.
		for (const section of VAULT_SECTION_DIRS) {
			expect((await fsp.stat(path.join(vaultLocation, section))).isDirectory()).toBe(true);
		}

		// ~/vault is a symlink that resolves (through the link) into the vault.
		const vaultLink = path.join(home, "vault");
		expect((await fsp.lstat(vaultLink)).isSymbolicLink()).toBe(true);
		expect((await fsp.stat(path.join(vaultLink, "projects"))).isDirectory()).toBe(true);
	});
});

// ===========================================================================
// (b) WS2 — two registry entities resolve to launch configs (C1 → C4/WS1).
// ===========================================================================

describe("(b) WS2 resolve — mixed-role entities → launch configs", () => {
	test("agent and persona records resolve with role-consistent retention policy", async () => {
		const agent = await resolveEntityConfig(AGENT_NAME, { registryRoot });
		const persona = await resolveEntityConfig(PERSONA_NAME, { registryRoot });

		expect(agent.role).toBe("agent");
		expect(agent.memory).toEqual({ backend: "mnemopi", bank: AGENT_BANK, autoRetain: true });
		expect(agent.vaultSection).toBe(AGENT_SECTION);
		expect(agent.model).toEqual(["anthropic/claude-sonnet-4"]);
		// On-demand system prompt loaded from the record body at resolution time.
		expect(agent.systemPrompt).toContain("Atlas coordinates work");

		expect(persona.role).toBe("persona");
		expect(persona.memory).toEqual({ backend: "mnemopi", bank: PERSONA_BANK, autoRetain: false });
		expect(persona.vaultSection).toBe(PERSONA_SECTION);
		expect(persona.systemPrompt).toContain("Phi is a narrow-domain persona");
	});

	test("C1 load-time policy rejects a persona that claims autoRetain: true", async () => {
		const badRoot = path.join(root, "bad-registry");
		await fsp.mkdir(path.join(badRoot, "entities"), { recursive: true });
		await fsp.writeFile(
			path.join(badRoot, "entities", "rogue.md"),
			`---\nname: rogue\ndescription: illegal curated+auto persona.\nrole: persona\nmemory:\n  backend: mnemopi\n  bank: rogue\n  autoRetain: true\nvaultSection: personas/rogue\n---\nbody\n`,
		);
		await expect(resolveEntityConfig("rogue", { registryRoot: badRoot })).rejects.toBeInstanceOf(
			EntityValidationError,
		);
	});
});

// ===========================================================================
// (c) WS3 — bank-scoped memory: policy resolved from the same registry (C1→C2).
// ===========================================================================

describe("(c) WS3 memory — retention policy + bank-scoped recall", () => {
	test("agent bank accepts auto-retain; persona bank rejects it; recall stays scoped", async () => {
		const store = new BankStore({ noEmbeddings: true, dataDir: path.join(root, "mem-data") });
		const policy = new BankPolicyRegistry({ registryRoot });
		const ctx = { store, policy } as const;
		try {
			// Agent (episodic) bank accepts an automatic capture.
			const auto = await memHandle(
				"retain",
				{ bank: AGENT_BANK, memory: "kingfisher migration over the estuary", mode: "auto" },
				ctx,
			);
			expect(auto.mode).toBe("auto");
			expect(auto.bank).toBe(AGENT_BANK);

			// Persona (curated-only) bank rejects an automatic capture at the write path.
			await expect(
				memHandle("retain", { bank: PERSONA_BANK, memory: "leaked episodic turn", mode: "auto" }, ctx),
			).rejects.toBeInstanceOf(RetentionPolicyError);

			// …but a deliberate (curated) write into the persona bank is allowed.
			const deliberate = await memHandle(
				"retain",
				{ bank: PERSONA_BANK, memory: "sourdough fermentation timing at altitude", mode: "deliberate" },
				ctx,
			);
			expect(deliberate.mode).toBe("deliberate");

			// Recall is per-bank: each bank sees only its own memory, no cross-bank bleed.
			const agentHits = (await memHandle("recall", { bank: AGENT_BANK, query: "kingfisher" }, ctx)).results as {
				content: string;
			}[];
			const personaHits = (await memHandle("recall", { bank: PERSONA_BANK, query: "sourdough" }, ctx)).results as {
				content: string;
			}[];
			const agentText = agentHits.map(r => r.content).join(" ");
			const personaText = personaHits.map(r => r.content).join(" ");
			expect(agentText).toContain("kingfisher");
			expect(agentText).not.toContain("sourdough");
			expect(personaText).toContain("sourdough");
			expect(personaText).not.toContain("kingfisher");

			// The rejected episodic write never landed in the persona bank.
			expect(personaText).not.toContain("leaked episodic");
		} finally {
			await store.close();
		}
	});
});

// ===========================================================================
// (d) WS4 — section-scoped write_note + search_notes round-trip, no leak.
// The Smart Connections embedding index is external, so we seed one .smart-env
// entry per section (fake embedder, no model, no network); the write and the
// read both hit the real files through the real bridge + tool dispatch.
// ===========================================================================

const MODEL_KEY = "TaylorAI/bge-micro-v2";
const ATLAS_NOTE = "## Estuary\nkingfisher migration timing over the estuary\n";
const PHI_NOTE = "## Sourdough\nsourdough fermentation timing at altitude\n";

class FakeEmbedder implements Embedder {
	readonly modelKey = MODEL_KEY;
	readonly dimensions = 4;
	async embed(text: string): Promise<number[]> {
		const t = text.toLowerCase();
		if (t.includes("estuary") || t.includes("kingfisher")) return [1, 0, 0, 0];
		if (t.includes("sourdough")) return [0, 1, 0, 0];
		return [0, 0, 0, 1];
	}
}

function seedSmartEnv(): void {
	const vec = (v: number[]) => ({ embeddings: { [MODEL_KEY]: { vec: v } } });
	const entries: Record<string, unknown> = {
		[`smart_sources:${AGENT_SECTION}/lessons.md`]: {
			...vec([1, 0, 0, 0]),
			blocks: { "#Estuary": { lines: [1, 2] } },
		},
		[`smart_blocks:${AGENT_SECTION}/lessons.md#Estuary`]: vec([1, 0, 0, 0]),
		[`smart_sources:${PERSONA_SECTION}/lessons.md`]: {
			...vec([0, 1, 0, 0]),
			blocks: { "#Sourdough": { lines: [1, 2] } },
		},
		[`smart_blocks:${PERSONA_SECTION}/lessons.md#Sourdough`]: vec([0, 1, 0, 0]),
	};
	const envDir = path.join(vaultLocation, ".smart-env");
	fs.mkdirSync(path.join(envDir, "multi"), { recursive: true });
	fs.writeFileSync(
		path.join(envDir, "smart_env.json"),
		JSON.stringify({ smart_sources: { embed_model: { transformers: { model_key: MODEL_KEY } } } }),
	);
	fs.writeFileSync(
		path.join(envDir, "multi", "all.ajson"),
		Object.entries(entries)
			.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
			.join(",\n"),
	);
}

describe("(d) WS4 vault — section-scoped write + search, no cross-section leak", () => {
	test("write_note lands in the owning section; search_notes returns it, scoped", async () => {
		seedSmartEnv();
		const atlasBridge = new VaultBridge({
			vaultRoot: vaultLocation,
			section: AGENT_SECTION,
			embedder: new FakeEmbedder(),
		});
		const phiBridge = new VaultBridge({
			vaultRoot: vaultLocation,
			section: PERSONA_SECTION,
			embedder: new FakeEmbedder(),
		});

		// Each entity writes into its own section via the C3 write_note tool.
		const atlasWrite = await vaultHandle(atlasBridge, "write_note", { path: "lessons.md", content: ATLAS_NOTE });
		const phiWrite = await vaultHandle(phiBridge, "write_note", { path: "lessons.md", content: PHI_NOTE });
		expect(atlasWrite.path).toBe(`${AGENT_SECTION}/lessons.md`);
		expect(phiWrite.path).toBe(`${PERSONA_SECTION}/lessons.md`);
		expect(fs.readFileSync(path.join(vaultLocation, AGENT_SECTION, "lessons.md"), "utf8")).toContain("kingfisher");

		// search_notes scoped to the atlas section returns the atlas block only,
		// with text read back from the file just written (a real round-trip).
		const atlasSearch = await vaultHandle(atlasBridge, "search_notes", { query: "tell me about the estuary" });
		const atlasHits = atlasSearch.hits as { file: string; text: string }[];
		expect(atlasHits.length).toBeGreaterThan(0);
		expect(atlasHits[0].file).toBe(`${AGENT_SECTION}/lessons.md`);
		expect(atlasHits[0].text).toContain("kingfisher");
		for (const h of atlasHits) expect(h.file.startsWith(`${AGENT_SECTION}/`)).toBe(true);

		// A query for the OTHER section's topic, scoped to atlas, never leaks phi's note.
		const leakProbe = await vaultHandle(atlasBridge, "search_notes", { query: "sourdough bread" });
		for (const h of leakProbe.hits as { file: string }[]) expect(h.file.startsWith(`${AGENT_SECTION}/`)).toBe(true);

		// And phi's own section resolves phi's note.
		const phiSearch = await vaultHandle(phiBridge, "search_notes", { query: "sourdough at altitude" });
		const phiHits = phiSearch.hits as { file: string; text: string }[];
		expect(phiHits.length).toBeGreaterThan(0);
		expect(phiHits.every(h => h.file.startsWith(`${PERSONA_SECTION}/`))).toBe(true);
		expect(phiHits[0].text).toContain("sourdough");
	});
});

// ===========================================================================
// (e) WS5 — peer delivery to a detached entity over the REAL supervisor.
// The model boundary is the only fake (a mode-aware fake resident session);
// supervisor routing + worker dispatch + transport are real.
// ===========================================================================

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

class PeerFakeSession implements ResidentSession {
	readonly sessionId: string;
	readonly sessionFile = "/tmp/e2e-peer.jsonl";
	readonly delivered: Array<{ from: string; text: string; mode: AgentMessageMode; outcome: string }> = [];
	#streaming = false;
	constructor(
		readonly activeSessionId: string,
		readonly cwd: string,
	) {
		this.sessionId = activeSessionId;
	}
	setStreaming(v: boolean): void {
		this.#streaming = v;
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

const NOOP_CLIENT: ClientChannel = { id: "e2e-driver", capabilities: [], sendEvent() {} };
function commandEnvelope(command: AgentControlCommand): AgentControlCommandEnvelope {
	return {
		type: "command",
		id: crypto.randomUUID(),
		protocol: AGENT_CONTROL_PROTOCOL_INFO,
		clientId: "e2e-driver",
		command,
	};
}
async function settle(): Promise<void> {
	for (let i = 0; i < 32; i++) await Promise.resolve();
}

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

describe("(e) WS5 peer — entity A delivers to detached entity B", () => {
	test("A steers to a detached B; receipt classified delivered; message lands in B's session", async () => {
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
		const supervisor = new AgentSupervisor({ spawner, commandTimeoutMs: 3000, handshakeTimeoutMs: 3000 });

		// Spawn A (atlas) and B (phi). B is never attached -> detached; its
		// resident worker is the delivery sink.
		const a = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: AGENT_NAME }), NOOP_CLIENT);
		const b = await supervisor.handle(commandEnvelope({ type: "spawn", entityName: PERSONA_NAME }), NOOP_CLIENT);
		if (a.type !== "spawn" || !a.ok || b.type !== "spawn" || !b.ok) throw new Error("spawn failed");
		await settle();

		const messenger = new PeerMessenger(new SupervisorPeerClient(supervisor));
		// Roster addresses both resident workers.
		expect((await messenger.roster()).map(r => r.entityName).sort()).toEqual([AGENT_NAME, PERSONA_NAME].sort());

		const bSession = sessions.get(b.id)!;
		// B busy: a steer interrupts the active turn and is a *delivered* receipt.
		bSession.setStreaming(true);
		const steer = await messenger.send(PERSONA_NAME, "handle the failing build", "steer", AGENT_NAME);
		expect(steer.outcome).toBe("injected");
		expect(peerReceiptStatus(steer)).toBe("delivered");

		// B idle: an auto message wakes a fresh turn (still delivered while detached).
		bSession.setStreaming(false);
		const auto = await messenger.send(PERSONA_NAME, "status?", "auto", AGENT_NAME);
		expect(peerReceiptStatus(auto)).toBe("delivered");

		// Both landed in the detached target's session, in order, attributed to A.
		expect(bSession.delivered.map(d => [d.from, d.mode, d.outcome])).toEqual([
			[AGENT_NAME, "steer", "injected"],
			[AGENT_NAME, "auto", "woken"],
		]);
	});
});

// ===========================================================================
// (f) WS6 — a generated pointer stub resolves @~/vault/... through the symlink.
// Wires WS2 (persona resolve) + WS6 (stub gen) + WS7a (~/vault symlink) + a real
// vault note, all at skill-read time.
// ===========================================================================

describe("(f) WS6 project pointer — @-import resolves through ~/vault", () => {
	const PROJECT = "oh-my-pi";
	const MARKER = "PHI-PROJECT-KNOWLEDGE-E2E";

	test("stub generated for the persona resolves to its vault note through the symlink", async () => {
		clearFsCache();
		// The project note lives in the vault (behind ~/vault), never in the repo.
		const notePath = path.join(vaultLocation, "projects", PROJECT, `${PERSONA_NAME}.md`);
		await fsp.mkdir(path.dirname(notePath), { recursive: true });
		await fsp.writeFile(notePath, `# Phi on ${PROJECT}\n\n${MARKER}: use the frozen C1 seam.\n`);

		// WS7 CLI seam: generate the stub for the entity, persona derived from C1.
		const projectDir = path.join(root, "project-repo");
		await fsp.mkdir(projectDir, { recursive: true });
		const stub = await generateProjectPointerForEntity({
			entityName: PERSONA_NAME,
			projectDir,
			project: PROJECT,
			registryRoot,
		});
		expect(stub.content).toContain(projectPointerImport(PROJECT, PERSONA_NAME));

		// The stub body is a pointer only — no content copied into the repo.
		const body = (await fsp.readFile(stub.skillPath, "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "").trim();
		expect(body).toBe(`@~/vault/projects/${PROJECT}/${PERSONA_NAME}.md`);

		// expandAtImports resolves the stub through the ~/vault symlink setup made.
		const expanded = await expandAtImports(body, stub.skillPath, { home });
		expect(expanded).toContain(MARKER);
		expect(expanded).not.toContain("@~/vault");

		// Full read-time path through buildSkillPromptMessage (home pinned to the
		// setup home, as on a machine where WS7a created ~/vault).
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
		try {
			const skill: Skill = {
				name: stub.skillName,
				description: "project pointer",
				filePath: stub.skillPath,
				baseDir: path.dirname(stub.skillPath),
				source: "native:project",
			};
			const built = await buildSkillPromptMessage(skill, "", "autoload");
			expect(built.message).toContain(MARKER);
			expect(built.message).not.toContain("@~/vault");
		} finally {
			homedirSpy.mockRestore();
		}
	});
});

// ===========================================================================
// (g) WS1 — a durable goal terminates at the continuation cap (no runaway).
// ===========================================================================

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

describe("(g) WS1 scheduler — durable goal terminates at the continuation cap", () => {
	test("a budget-less goal stops at the cap even when usage is never recorded", async () => {
		const injector = new StubInjector();
		const persisted: GoalCheckpointData[] = [];
		const goal = new GoalController({ injector, persist: d => void persisted.push(d), maxContinuations: 3 });
		goal.set({ objective: "keep improving the project forever" });

		// Drive far more idle transitions than the cap; it must still terminate.
		for (let i = 0; i < 20; i++) await goal.afterTurn();

		const status = goal.status();
		expect(status.active).toBe(false);
		expect(status.status).toBe("budget_limited");
		expect(status.continuationsUsed).toBe(3);
		// 3 continuation prompts + exactly one terminal wind-down, then nothing.
		expect(injector.prompts).toHaveLength(4);
		expect(persisted.at(-1)?.lastReason).toBe("max_continuations");
	});
});

// ===========================================================================
// (c+d through the spawn glue) — memory (C2) + vault (C3) exercised THROUGH the
// worker's own composition path: buildEntityMcpManager spawns the REAL memory
// and vault stdio MCP servers (dev: `bun run <server>.ts`), connects them via
// MCPManager, and every tool call rides the real stdio JSON-RPC transport the
// resident worker uses. The only injected fake anywhere is the model boundary;
// this leg has none — it is fully real, and fully offline (memory recall is
// FTS, so no embedder/network is contacted).
// ===========================================================================

function unwrapToolJson(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): {
	data: Record<string, unknown>;
	isError: boolean;
} {
	const text = result.content?.find(b => b.type === "text")?.text ?? "{}";
	return { data: JSON.parse(text) as Record<string, unknown>, isError: result.isError === true };
}

describe("(c+d) memory + vault through the real spawn glue (buildEntityMcpManager)", () => {
	test("worker MCP composition: banks/sections bound, retain policy enforced, plain-file round-trip", async () => {
		// buildEntityMcpManager resolves the registry + vault from the wired env
		// (the symlinks/env WS7a setup establishes), exactly like a real worker.
		const prevRegistry = process.env.OMP_ENTITY_REGISTRY;
		const prevVault = process.env.OMP_VAULT_PATH;
		process.env.OMP_ENTITY_REGISTRY = registryRoot;
		process.env.OMP_VAULT_PATH = vaultLocation;

		const agentCfg = await resolveEntityConfig(AGENT_NAME, { registryRoot });
		const personaCfg = await resolveEntityConfig(PERSONA_NAME, { registryRoot });
		const cwd = path.join(root, "worker-cwd");
		await fsp.mkdir(cwd, { recursive: true });

		const agentMgr = await buildEntityMcpManager(agentCfg, cwd);
		const personaMgr = await buildEntityMcpManager(personaCfg, cwd);
		try {
			expect(agentMgr).toBeDefined();
			expect(personaMgr).toBeDefined();
			const agentMem = agentMgr!.getConnection("memory")!;
			const agentVault = agentMgr!.getConnection("vault")!;
			const personaMem = personaMgr!.getConnection("memory")!;
			const personaVault = personaMgr!.getConnection("vault")!;
			expect(agentMem).toBeDefined();
			expect(agentVault).toBeDefined();

			// The C2/C3 tool surface is really advertised over the live transport.
			const memTools = (await listTools(agentMem)).map(t => t.name).sort();
			const vaultTools = (await listTools(agentVault)).map(t => t.name).sort();
			expect(memTools).toEqual(["forget", "recall", "retain"]);
			expect(vaultTools).toEqual(["get_connections", "get_note", "search_notes", "write_note"].sort());

			// C2: the agent (episodic) server accepts auto-retain into its bound
			// bank (no `bank` arg — the --bank flag binds it), recall reads it back.
			const agentRetain = unwrapToolJson(
				await callTool(agentMem, "retain", { memory: "kingfisher migration over the estuary", mode: "auto" }),
			);
			expect(agentRetain.isError).toBe(false);
			expect(agentRetain.data.bank).toBe(AGENT_BANK);
			expect(agentRetain.data.mode).toBe("auto");
			const agentRecall = unwrapToolJson(await callTool(agentMem, "recall", { query: "kingfisher" }));
			expect(agentRecall.data.bank).toBe(AGENT_BANK);
			expect(JSON.stringify(agentRecall.data.results)).toContain("kingfisher");

			// C2 policy: the persona (curated-only) server rejects auto-retain
			// through the real policy path, but accepts a deliberate curated write.
			const personaAuto = unwrapToolJson(
				await callTool(personaMem, "retain", { memory: "leaked episodic turn", mode: "auto" }),
			);
			expect(personaAuto.isError).toBe(true);
			expect(JSON.stringify(personaAuto.data).toLowerCase()).toContain("curated");
			const personaDeliberate = unwrapToolJson(
				await callTool(personaMem, "retain", { memory: "sourdough fermentation timing", mode: "deliberate" }),
			);
			expect(personaDeliberate.isError).toBe(false);
			expect(personaDeliberate.data.bank).toBe(PERSONA_BANK);

			// C3: write_note lands in the server's bound section (--section), and
			// get_note reads it back — a real plain-file round-trip over stdio.
			const write = unwrapToolJson(
				await callTool(agentVault, "write_note", {
					path: "glue-note.md",
					content: "## Estuary\nkingfisher notes\n",
				}),
			);
			expect(write.data.path).toBe(`${AGENT_SECTION}/glue-note.md`);
			const get = unwrapToolJson(await callTool(agentVault, "get_note", { path: "glue-note.md" }));
			expect(get.data.path).toBe(`${AGENT_SECTION}/glue-note.md`);
			expect(String(get.data.content)).toContain("kingfisher notes");

			// C3 confinement: the persona's vault server is bound to its own
			// section, so a bare relative write cannot land in the agent's subtree.
			const personaWrite = unwrapToolJson(
				await callTool(personaVault, "write_note", { path: "glue-note.md", content: "## Sourdough\nphi notes\n" }),
			);
			expect(personaWrite.data.path).toBe(`${PERSONA_SECTION}/glue-note.md`);
		} finally {
			await agentMgr?.disconnectAll();
			await personaMgr?.disconnectAll();
			if (prevRegistry === undefined) delete process.env.OMP_ENTITY_REGISTRY;
			else process.env.OMP_ENTITY_REGISTRY = prevRegistry;
			if (prevVault === undefined) delete process.env.OMP_VAULT_PATH;
			else process.env.OMP_VAULT_PATH = prevVault;
		}
	}, 60_000);
});
