import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	discoverEntities,
	EntityNotFoundError,
	EntityValidationError,
	loadEntityRecord,
	parseEntityRecord,
	resolveEntityConfig,
} from "@oh-my-pi/pi-coding-agent/entity";

const AGENT_RECORD = `---
name: atlas
description: Coordinator agent.
role: agent
model: ["@slow"]
thinkingLevel: high
tools: [read, grep, glob, edit, write, bash, task]
autoloadSkills: [codebase-design]
memory: { backend: mnemopi, bank: atlas, autoRetain: true }
vaultSection: agents/atlas
---

You are Atlas, a coordinator agent.
`;

const PERSONA_RECORD = `---
name: phi
description: OMP expert persona.
role: persona
model: [anthropic/opus]
thinkingLevel: high
tools: [read, grep, glob]
autoloadSkills: [writing-for-agents]
memory: { backend: mnemopi, bank: phi, autoRetain: false }
vaultSection: personas/phi
watchdog: { name: phi-guard, model: "@fast", tools: [read, grep], instructions: Watch for hallucinated APIs., enabled: true }
hosting: { modelEndpoint: anthropic }
---

You are Phi, the OMP/pi expert persona.
`;

describe("entity registry — schema load/validate (C1)", () => {
	it("accepts a valid agent record and allows episodic auto-retention", () => {
		const record = parseEntityRecord("/tmp/atlas.md", AGENT_RECORD, "user");
		expect(record.name).toBe("atlas");
		expect(record.role).toBe("agent");
		expect(record.memory).toEqual({ backend: "mnemopi", bank: "atlas", autoRetain: true });
		expect(record.model).toEqual(["@slow"]);
		expect(record.thinkingLevel).toBeDefined();
		expect(record.tools).toContain("bash");
		expect(record.vaultSection).toBe("agents/atlas");
		expect(record.systemPrompt).toBe("You are Atlas, a coordinator agent.");
	});

	it("accepts a valid persona record and parses watchdog + hosting", () => {
		const record = parseEntityRecord("/tmp/phi.md", PERSONA_RECORD, "user");
		expect(record.role).toBe("persona");
		expect(record.memory.autoRetain).toBe(false);
		expect(record.watchdog).toEqual({
			name: "phi-guard",
			model: "@fast",
			tools: ["read", "grep"],
			instructions: "Watch for hallucinated APIs.",
			enabled: true,
		});
		expect(record.hosting).toEqual({ modelEndpoint: "anthropic" });
	});

	it("rejects a persona that sets memory.autoRetain: true (curated-only policy)", () => {
		const illegal = `---
name: bad-persona
description: illegal.
role: persona
memory: { backend: mnemopi, bank: bad, autoRetain: true }
vaultSection: personas/bad
---

body
`;
		expect(() => parseEntityRecord("/tmp/bad.md", illegal, "user")).toThrow(EntityValidationError);
		expect(() => parseEntityRecord("/tmp/bad.md", illegal, "user")).toThrow(/curated-only/);
	});

	it("rejects a missing or invalid role (no silent default)", () => {
		const noRole = `---
name: x
description: d.
memory: { backend: mnemopi, bank: x, autoRetain: false }
vaultSection: agents/x
---
body
`;
		expect(() => parseEntityRecord("/tmp/x.md", noRole, "user")).toThrow(/role/);
	});

	it("rejects a missing memory binding", () => {
		const noMemory = `---
name: x
description: d.
role: agent
vaultSection: agents/x
---
body
`;
		expect(() => parseEntityRecord("/tmp/x.md", noMemory, "user")).toThrow(/memory/);
	});

	it("rejects an unsupported memory backend", () => {
		const badBackend = `---
name: x
description: d.
role: agent
memory: { backend: sqlite, bank: x, autoRetain: false }
vaultSection: agents/x
---
body
`;
		expect(() => parseEntityRecord("/tmp/x.md", badBackend, "user")).toThrow(/memory\.backend/);
	});

	it("rejects a filesystem-unsafe entity name", () => {
		const badName = `---
name: bad/name
description: d.
role: agent
memory: { backend: mnemopi, bank: x, autoRetain: false }
vaultSection: agents/x
---
body
`;
		expect(() => parseEntityRecord("/tmp/bad.md", badName, "user")).toThrow(/name/);
	});

	it("rejects an empty system prompt body", () => {
		const emptyBody = `---
name: x
description: d.
role: agent
memory: { backend: mnemopi, bank: x, autoRetain: false }
vaultSection: agents/x
---
`;
		expect(() => parseEntityRecord("/tmp/x.md", emptyBody, "user")).toThrow(/system prompt/);
	});
});

describe("entity registry — record → session config resolution (C1 → WS1)", () => {
	let root: string;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-entity-"));
		const entities = path.join(root, "entities");
		await fs.mkdir(entities, { recursive: true });
		await fs.writeFile(path.join(entities, "atlas.md"), AGENT_RECORD);
		await fs.writeFile(path.join(entities, "phi.md"), PERSONA_RECORD);
	});

	afterAll(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("resolves a record into a launchable session config with the prompt loaded on demand", async () => {
		const config = await resolveEntityConfig("phi", { registryRoot: root, cwd: "/work/project" });
		expect(config.name).toBe("phi");
		expect(config.description).toBe("OMP expert persona.");
		expect(config.role).toBe("persona");
		expect(config.model).toEqual(["anthropic/opus"]);
		expect(config.tools).toEqual(["read", "grep", "glob"]);
		expect(config.memory).toEqual({ backend: "mnemopi", bank: "phi", autoRetain: false });
		expect(config.vaultSection).toBe("personas/phi");
		expect(config.watchdog?.name).toBe("phi-guard");
		expect(config.hosting).toEqual({ modelEndpoint: "anthropic" });
		// Prompt is loaded on demand at resolution, not before.
		expect(config.systemPrompt).toBe("You are Phi, the OMP/pi expert persona.");
		// cwd is threaded from the launch context, not the record.
		expect(config.cwd).toBe("/work/project");
		expect(config.source.filePath).toBe(path.join(root, "entities", "phi.md"));
	});

	it("leaves cwd undefined when the launch context supplies none", async () => {
		const config = await resolveEntityConfig("atlas", { registryRoot: root });
		expect(config.cwd).toBeUndefined();
		expect(config.memory.autoRetain).toBe(true);
	});

	it("resolves a persona with every C1 field populated (no unpopulated field, prompt on demand)", async () => {
		const config = await resolveEntityConfig("phi", { registryRoot: root, cwd: "/work/project" });
		// Every field the WS2->WS1 seam contracts (C1) must be present for a fully
		// specified record — including thinkingLevel + autoloadSkills, which the
		// launch mapping threads through and earlier assertions did not cover.
		expect(String(config.thinkingLevel)).toBe("high");
		expect(config.autoloadSkills).toEqual(["writing-for-agents"]);
		const populated: Array<keyof typeof config> = [
			"name",
			"description",
			"role",
			"model",
			"thinkingLevel",
			"systemPrompt",
			"tools",
			"autoloadSkills",
			"memory",
			"vaultSection",
			"watchdog",
			"hosting",
			"cwd",
			"source",
		];
		for (const field of populated) {
			expect(config[field], `resolved config.${String(field)} must be populated`).toBeDefined();
		}
		// On-demand prompt is present and non-empty at resolution.
		expect(config.systemPrompt.length).toBeGreaterThan(0);
	});

	it("throws EntityNotFoundError for an unknown entity", async () => {
		await expect(loadEntityRecord("ghost", { registryRoot: root })).rejects.toThrow(EntityNotFoundError);
	});

	it("rejects an illegal name before touching the filesystem", async () => {
		await expect(resolveEntityConfig("../escape", { registryRoot: root })).rejects.toThrow(EntityValidationError);
	});
});

describe("entity registry — roster discovery (on-demand discipline)", () => {
	let root: string;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-roster-"));
		const entities = path.join(root, "entities");
		await fs.mkdir(entities, { recursive: true });
		await fs.writeFile(path.join(entities, "atlas.md"), AGENT_RECORD);
		await fs.writeFile(path.join(entities, "phi.md"), PERSONA_RECORD);
		// A malformed record (missing role) must be surfaced, not crash the roster.
		await fs.writeFile(
			path.join(entities, "broken.md"),
			`---
name: broken
description: no role.
memory: { backend: mnemopi, bank: broken, autoRetain: false }
vaultSection: agents/broken
---
body
`,
		);
	});

	afterAll(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("scans frontmatter only and holds no eagerly-loaded prompt body", async () => {
		const { entities, errors } = await discoverEntities({ registryRoot: root });
		expect(entities.map(e => e.name)).toEqual(["atlas", "phi"]);
		// Roster metadata carries no system prompt (SPEC §5 context-cost discipline).
		for (const meta of entities) {
			expect("systemPrompt" in meta).toBe(false);
		}
		expect(errors).toHaveLength(1);
		expect(errors[0]?.filePath).toBe(path.join(root, "entities", "broken.md"));
		expect(errors[0]?.error).toMatch(/role/);
	});

	it("picks up a newly dropped-in record with no code change (drop-in data)", async () => {
		// SPEC §12.2 acceptance: adding an entity needs no code change. Drop a new
		// Markdown record into the registry dir at runtime; discovery + resolution
		// must surface and resolve it purely from data.
		const newFile = path.join(root, "entities", "nova.md");
		await fs.writeFile(
			newFile,
			`---
name: nova
description: dropped-in agent.
role: agent
model: [anthropic/opus]
memory: { backend: mnemopi, bank: nova, autoRetain: true }
vaultSection: agents/nova
---

You are Nova.
`,
		);
		try {
			const { entities } = await discoverEntities({ registryRoot: root });
			expect(entities.map(e => e.name)).toContain("nova");
			const config = await resolveEntityConfig("nova", { registryRoot: root });
			expect(config.role).toBe("agent");
			expect(config.memory).toEqual({ backend: "mnemopi", bank: "nova", autoRetain: true });
			expect(config.systemPrompt).toBe("You are Nova.");
		} finally {
			await fs.rm(newFile, { force: true });
		}
	});

	it("returns an empty roster (no throw) when the registry has no records", async () => {
		const empty = await fs.mkdtemp(path.join(os.tmpdir(), "omp-empty-"));
		try {
			const { entities, errors } = await discoverEntities({ registryRoot: empty });
			expect(entities).toEqual([]);
			expect(errors).toEqual([]);
		} finally {
			await fs.rm(empty, { recursive: true, force: true });
		}
	});
});
