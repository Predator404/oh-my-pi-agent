/**
 * WS7 — per-entity MCP wiring (integration P1). buildEntityMcpServers composes
 * the memory (bank-bound) + vault (section-scoped) stdio servers the daemon
 * worker hands to its MCPManager at spawn.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	buildEntityMcpServers,
	ENTITY_MCP_SERVER_NAMES,
	type EntityMcpConfig,
} from "@oh-my-pi/pi-coding-agent/entity/mcp-wiring";

const config: EntityMcpConfig = {
	memory: { backend: "mnemopi", bank: "phi", autoRetain: false },
	vaultSection: "personas/phi",
};

const savedEnv = { ...process.env };
afterEach(() => {
	process.env = { ...savedEnv };
});

describe("buildEntityMcpServers", () => {
	it("binds memory to the entity bank + registry, vault to the section (compiled/bin mode)", () => {
		const servers = buildEntityMcpServers(config, { dev: false, registryRoot: "/reg", vaultRoot: "/vault" });

		expect(Object.keys(servers).sort()).toEqual([ENTITY_MCP_SERVER_NAMES.memory, ENTITY_MCP_SERVER_NAMES.vault]);

		const memory = servers.memory as { command: string; args: string[]; env?: Record<string, string> };
		expect(memory.command).toBe("omp-memory-mcp");
		expect(memory.args).toEqual(["--registry", "/reg", "--bank", "phi"]);
		expect(memory.env).toEqual({ OMP_ENTITY_REGISTRY: "/reg" });

		const vault = servers.vault as { command: string; args: string[] };
		expect(vault.command).toBe("omp-vault-mcp");
		expect(vault.args).toEqual(["--vault", "/vault", "--section", "personas/phi"]);
	});

	it("launches via `bun run <module>` in a dev checkout", () => {
		const servers = buildEntityMcpServers(config, { dev: true, registryRoot: "/reg", vaultRoot: "/vault" });
		const memory = servers.memory as { command: string; args: string[] };
		const vault = servers.vault as { command: string; args: string[] };
		expect(memory.command).toBe("bun");
		expect(memory.args[0]).toBe("run");
		expect(memory.args).toContain("--bank");
		expect(memory.args).toContain("phi");
		expect(memory.args[1]).toMatch(/memory-mcp\/server\.ts$/);
		expect(vault.command).toBe("bun");
		expect(vault.args[1]).toMatch(/vault-mcp\/server\.ts$/);
		expect(vault.args.slice(-4)).toEqual(["--vault", "/vault", "--section", "personas/phi"]);
	});

	it("defaults registryRoot from OMP_ENTITY_REGISTRY and vaultRoot from OMP_VAULT_PATH", () => {
		process.env.OMP_ENTITY_REGISTRY = "/env/reg";
		process.env.OMP_VAULT_PATH = "/env/vault";
		const servers = buildEntityMcpServers(config, { dev: false });
		const memory = servers.memory as { args: string[]; env?: Record<string, string> };
		const vault = servers.vault as { args: string[] };
		expect(memory.args).toEqual(["--registry", "/env/reg", "--bank", "phi"]);
		expect(memory.env?.OMP_ENTITY_REGISTRY).toBe("/env/reg");
		expect(vault.args).toEqual(["--vault", "/env/vault", "--section", "personas/phi"]);
	});
});
