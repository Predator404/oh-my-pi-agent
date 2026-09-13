/**
 * Registry manifest (ADR 0004) — directional access resolution, the Q9
 * public-can-never-read-private guard, non-transitivity, and the private-only
 * bank-namespace policy. These defend the isolation invariants a leak would
 * violate, not incidental shape.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	EntityValidationError,
	parseRegistryManifest,
	RegistryManifestError,
	resolveRegistryAccess,
	visibleRegistryIds,
} from "@oh-my-pi/pi-coding-agent/entity";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

const ROOTS = {
	oma: { root: "/roots/oma", visibility: "public" },
	capitec: { root: "/roots/capitec", visibility: "private", readableBy: [] as string[] },
	clientx: { root: "/roots/clientx", visibility: "private", readableBy: ["capitec"] },
	deep: { root: "/roots/deep", visibility: "private", readableBy: ["clientx"] },
} as const;

describe("registry manifest — directional access (ADR 0004 Q4/Q9/Q11)", () => {
	const manifest = parseRegistryManifest(structuredClone(ROOTS), "<test>");

	it("a private registry reads home (writable) + all public + only directly-granted private", () => {
		const access = resolveRegistryAccess(manifest, "capitec");
		expect(access.find(a => a.id === "capitec")?.writable).toBe(true);
		// capitec reads oma (public) and clientx (granted), but NOT deep (granted only to clientx — non-transitive).
		expect(visibleRegistryIds(manifest, "capitec")).toEqual(["capitec", "oma", "clientx"]);
		// Nothing outside the home is writable.
		expect(access.filter(a => a.writable).map(a => a.id)).toEqual(["capitec"]);
	});

	it("a public registry can never read a private one (the core invariant)", () => {
		// oma is public: it sees only itself — no private registry, grant or not.
		expect(visibleRegistryIds(manifest, "oma")).toEqual(["oma"]);
	});

	it("grants are non-transitive: capitec→clientx→deep does not give capitec→deep", () => {
		expect(visibleRegistryIds(manifest, "clientx")).toEqual(["clientx", "oma", "deep"]);
		expect(visibleRegistryIds(manifest, "capitec")).not.toContain("deep");
	});
});

describe("registry manifest — load-time guards", () => {
	it("rejects a public registry named as a reader of a private one (Q9)", () => {
		expect(() =>
			parseRegistryManifest(
				{
					oma: { root: "/o", visibility: "public" },
					cap: { root: "/c", visibility: "private", readableBy: ["oma"] },
				},
				"<t>",
			),
		).toThrow(/public/);
	});

	it("rejects readableBy on a public registry", () => {
		expect(() =>
			parseRegistryManifest({ oma: { root: "/o", visibility: "public", readableBy: ["x"] } }, "<t>"),
		).toThrow(RegistryManifestError);
	});

	it("rejects an unknown reader id and a self-grant", () => {
		expect(() =>
			parseRegistryManifest({ c: { root: "/c", visibility: "private", readableBy: ["ghost"] } }, "<t>"),
		).toThrow(/unknown/);
		expect(() =>
			parseRegistryManifest({ c: { root: "/c", visibility: "private", readableBy: ["c"] } }, "<t>"),
		).toThrow(/itself/);
	});
});

const OMA_PHI = `---
name: phi
description: OMP expert.
role: persona
memory: { backend: mnemopi, bank: phi, autoRetain: false }
vaultSection: personas/phi
---
You are Phi.
`;

const CAP_EXPERT = `---
name: expert
description: Capitec expert.
role: persona
memory: { backend: mnemopi, bank: capitec/expert, autoRetain: false }
vaultSection: personas/expert
---
You are the Capitec expert.
`;

const CAP_BADBANK = `---
name: bad
description: unprefixed bank in a private registry.
role: persona
memory: { backend: mnemopi, bank: bad, autoRetain: false }
vaultSection: personas/bad
---
Bad.
`;

describe("registry manifest — records partition by registry + bank namespace (Q5/Q6)", () => {
	it("populates the home registry id and enforces the private bank-namespace rule", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reg-"));
		const prevRegistry = process.env.OMP_ENTITY_REGISTRY;
		try {
			const omaRoot = path.join(base, "oma");
			await fs.mkdir(path.join(omaRoot, "entities"), { recursive: true });
			await fs.writeFile(path.join(omaRoot, "entities", "phi.md"), OMA_PHI);

			// Set the entity registry root for discovery
			process.env.OMP_ENTITY_REGISTRY = omaRoot;
			const { agents } = await discoverAgents(base, os.homedir());
			const phi = agents.find(a => a.name === "phi");
			expect(phi).toBeDefined();
			expect(phi!.registry).toBe("oma");

			// Registry manifest access resolution still works independently
			const manifest = parseRegistryManifest(
				{
					oma: { root: omaRoot, visibility: "public" },
					capitec: { root: path.join(base, "capitec"), visibility: "private", readableBy: [] },
				},
				"<test>",
			);
			const access = resolveRegistryAccess(manifest, "oma");
			expect(access.find(a => a.id === "oma")?.writable).toBe(true);
		} finally {
			process.env.OMP_ENTITY_REGISTRY = prevRegistry;
			await fs.rm(base, { recursive: true, force: true });
		}
	});
});
