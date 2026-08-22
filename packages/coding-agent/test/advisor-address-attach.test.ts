import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// A persona record the registry can discover + resolve. No `model` field, so the
// attached advisor falls back to the session's `advisor` role model.
const PHI_RECORD = `---
name: phi
description: Careful reviewer persona.
role: persona
memory:
  backend: mnemopi
  bank: phi
vaultSection: personas/phi
---
You are Phi.
`;

// Verifies the submit-time contract behind `@@<name>:` addressing: a name with no
// live advisor is attached from the OMA entity registry, and the advisor
// subsystem is started when it was off. The model-driven answer is exercised
// interactively; this covers the deterministic attach/start half.
describe("advisor direct-address attach", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let session: AgentSession;
	const originalRegistry = process.env.OMP_ENTITY_REGISTRY;

	beforeEach(async () => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;

		tempDir = TempDir.createSync("@pi-advisor-attach-");
		const entitiesDir = path.join(tempDir.path(), "entities");
		await fs.mkdir(entitiesDir, { recursive: true });
		await fs.writeFile(path.join(entitiesDir, "phi.md"), PHI_RECORD);
		process.env.OMP_ENTITY_REGISTRY = tempDir.path();

		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, advisorTools: [] });
	});

	afterEach(async () => {
		await session.dispose();
		if (originalRegistry === undefined) delete process.env.OMP_ENTITY_REGISTRY;
		else process.env.OMP_ENTITY_REGISTRY = originalRegistry;
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("attaches a registry entity and starts the advisor subsystem when off", async () => {
		expect(session.isAdvisorEnabled()).toBe(false);
		expect(session.isAdvisorActive()).toBe(false);

		// Address token case is normalized to the entity's canonical name.
		const attached = await session.attachAddressedAdvisor("Phi");

		expect(attached).toBe("phi");
		expect(session.isAdvisorEnabled()).toBe(true);
		expect(session.isAdvisorActive()).toBe(true);
		expect(session.getAdvisorStats().advisors.map(a => a.name)).toContain("phi");
	});

	it("is idempotent: re-addressing an already-attached entity keeps one runtime", async () => {
		await session.attachAddressedAdvisor("phi");
		const again = await session.attachAddressedAdvisor("phi");
		expect(again).toBe("phi");
		expect(session.getAdvisorStats().advisors.filter(a => a.name === "phi")).toHaveLength(1);
	});

	it("leaves the subsystem untouched for an unknown name", async () => {
		const attached = await session.attachAddressedAdvisor("nobody");
		expect(attached).toBeUndefined();
		expect(session.isAdvisorEnabled()).toBe(false);
		expect(session.isAdvisorActive()).toBe(false);
	});

	it("carries the entity's thinkingLevel onto the attached advisor", async () => {
		// A persona with its own model + a standalone thinkingLevel field. The
		// advisor config has no thinking field, so attach must fold the level into
		// the model selector or the effort is lost.
		await Bun.write(
			path.join(tempDir.path(), "entities", "sage.md"),
			"---\nname: sage\ndescription: Deep reviewer.\nrole: persona\nmemory:\n  backend: mnemopi\n  bank: sage\nvaultSection: personas/sage\nmodel:\n  - anthropic/claude-sonnet-4-5\nthinkingLevel: high\n---\nYou are Sage.\n",
		);

		const attached = await session.attachAddressedAdvisor("sage");
		expect(attached).toBe("sage");
		expect(session.getAdvisorAgent()?.state.thinkingLevel).toBe(Effort.High);
	});
});
