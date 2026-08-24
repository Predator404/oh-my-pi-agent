/**
 * WS7 — per-entity MCP wiring (integration P1). buildEntityMcpServers composes
 * the memory (bank-bound) + vault (access-set) stdio servers the daemon worker
 * hands to its MCPManager at spawn. Under ADR 0004 the vault access set comes
 * from the registries manifest: the writable home root plus every readable
 * (public/granted-private) root, with memory records living in the home root.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { parseRegistryManifest } from "@oh-my-pi/pi-coding-agent/entity";
import {
	buildEntityMcpServers,
	ENTITY_MCP_SERVER_NAMES,
	type EntityMcpConfig,
} from "@oh-my-pi/pi-coding-agent/entity/mcp-wiring";

const config: EntityMcpConfig = {
	memory: { backend: "mnemopi", bank: "phi", autoRetain: false },
	vaultSection: "personas/phi",
	registry: "phi",
};

// Private home "phi" (records + writes) with the public "oma" registry readable.
const manifest = parseRegistryManifest(
	{
		phi: { root: "/roots/phi", visibility: "private", readableBy: [] },
		oma: { root: "/roots/oma", visibility: "public" },
	},
	"<test>",
);

const savedEnv = { ...process.env };
afterEach(() => {
	process.env = { ...savedEnv };
});

describe("buildEntityMcpServers", () => {
	it("maps the home registry root → vault --vault + memory --registry, readable roots → --read (bin mode)", async () => {
		const servers = await buildEntityMcpServers(config, { dev: false, manifest });

		expect(Object.keys(servers).sort()).toEqual([ENTITY_MCP_SERVER_NAMES.memory, ENTITY_MCP_SERVER_NAMES.vault]);

		const memory = servers.memory as { command: string; args: string[]; env?: Record<string, string> };
		expect(memory.command).toBe("omp-memory-mcp");
		// Records live in the HOME registry root.
		expect(memory.args).toEqual(["--registry", "/roots/phi", "--bank", "phi"]);
		expect(memory.env).toEqual({ OMP_ENTITY_REGISTRY: "/roots/phi" });

		const vault = servers.vault as { command: string; args: string[] };
		expect(vault.command).toBe("omp-vault-mcp");
		// Home root + section + home-id, then the granted public registry as read-only.
		expect(vault.args).toEqual([
			"--vault",
			"/roots/phi",
			"--section",
			"personas/phi",
			"--home-id",
			"phi",
			"--read",
			"oma=/roots/oma",
		]);
	});

	it("launches via `bun run <module>` in a dev checkout", async () => {
		const servers = await buildEntityMcpServers(config, { dev: true, manifest });
		const memory = servers.memory as { command: string; args: string[] };
		const vault = servers.vault as { command: string; args: string[] };
		expect(memory.command).toBe("bun");
		expect(memory.args[0]).toBe("run");
		expect(memory.args[1]).toMatch(/memory-mcp\/server\.ts$/);
		expect(memory.args.slice(-4)).toEqual(["--registry", "/roots/phi", "--bank", "phi"]);
		expect(vault.command).toBe("bun");
		expect(vault.args[1]).toMatch(/vault-mcp\/server\.ts$/);
		expect(vault.args.slice(2)).toEqual([
			"--vault",
			"/roots/phi",
			"--section",
			"personas/phi",
			"--home-id",
			"phi",
			"--read",
			"oma=/roots/oma",
		]);
	});

	it("a public home registry reads sibling public registries as --read roots", async () => {
		const publicManifest = parseRegistryManifest(
			{
				oma: { root: "/roots/oma", visibility: "public" },
				capitec: { root: "/roots/capitec", visibility: "public" },
			},
			"<test>",
		);
		const servers = await buildEntityMcpServers(
			{ ...config, registry: "oma" },
			{ dev: false, manifest: publicManifest },
		);
		const memory = servers.memory as { args: string[] };
		const vault = servers.vault as { args: string[] };
		expect(memory.args).toEqual(["--registry", "/roots/oma", "--bank", "phi"]);
		expect(vault.args).toEqual([
			"--vault",
			"/roots/oma",
			"--section",
			"personas/phi",
			"--home-id",
			"oma",
			"--read",
			"capitec=/roots/capitec",
		]);
	});

	it("falls back to legacy single-root wiring when the manifest can't resolve the home id", async () => {
		// Home id absent from the manifest → legacy resolveVaultRoot/getEntityRegistryRoot path.
		const servers = await buildEntityMcpServers(
			{ ...config, registry: "ghost" },
			{ dev: false, manifest, registryRoot: "/reg", vaultRoot: "/vault" },
		);
		const memory = servers.memory as { args: string[]; env?: Record<string, string> };
		const vault = servers.vault as { args: string[] };
		expect(memory.args).toEqual(["--registry", "/reg", "--bank", "phi"]);
		expect(memory.env).toEqual({ OMP_ENTITY_REGISTRY: "/reg" });
		// No --read / --home-id flags: exactly the pre-ADR-0004 single-root shape.
		expect(vault.args).toEqual(["--vault", "/vault", "--section", "personas/phi"]);
	});

	it("legacy fallback defaults registryRoot from OMP_ENTITY_REGISTRY and vaultRoot from OMP_VAULT_PATH", async () => {
		process.env.OMP_ENTITY_REGISTRY = "/env/reg";
		process.env.OMP_VAULT_PATH = "/env/vault";
		const servers = await buildEntityMcpServers({ ...config, registry: "ghost" }, { dev: false, manifest });
		const memory = servers.memory as { args: string[]; env?: Record<string, string> };
		const vault = servers.vault as { args: string[] };
		expect(memory.args).toEqual(["--registry", "/env/reg", "--bank", "phi"]);
		expect(memory.env?.OMP_ENTITY_REGISTRY).toBe("/env/reg");
		expect(vault.args).toEqual(["--vault", "/env/vault", "--section", "personas/phi"]);
	});
});
