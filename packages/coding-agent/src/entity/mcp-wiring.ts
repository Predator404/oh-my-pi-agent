/**
 * WS7 — per-entity MCP wiring (integration P1).
 *
 * Each resident entity worker exposes two per-entity MCP servers alongside OMP's
 * normal tool surface:
 *   - **memory** (WS3, contract C2): bank-scoped recall/retain/forget. One
 *     shared server addresses many banks; the entity is bound to its own
 *     `memory.bank` via the server's `--bank` default (an explicit `bank` per
 *     call still overrides).
 *   - **vault** (WS4, contract C3): search/read/write scoped to the entity's
 *     `vaultSection` under the shared vault root (the `~/vault` symlink WS7a
 *     creates), via {@link vaultMcpServerConfig}.
 *
 * {@link buildEntityMcpServers} produces the `mcpServers` map (the `.omp/mcp.json`
 * shape). The daemon worker (WS1) builds it at spawn from the resolved entity
 * config and hands it to a `MCPManager` it owns — dynamic + in-memory, so no
 * `.omp/mcp.json` is written and no project directory is polluted. WS1 owns the
 * manager lifecycle; this module owns the composition.
 */
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { MCPServerConfig } from "../mcp/types";
import { vaultMcpServerConfig } from "../vault-mcp/register";
import { getEntityRegistryRoot } from "./loader";
import type { ResolvedEntityConfig } from "./schema";

/** Default bin name for the WS3 bank-scoped memory MCP server. */
export const MEMORY_MCP_BIN = "omp-memory-mcp";

/** Environment variable pointing the vault MCP at the shared vault root (WS4). */
export const VAULT_PATH_ENV = "OMP_VAULT_PATH";

/** Server names an entity's worker registers. Stable so re-wiring overwrites, never duplicates. */
export const ENTITY_MCP_SERVER_NAMES = { memory: "memory", vault: "vault" } as const;

/** The C1 fields the wiring reads. */
export type EntityMcpConfig = Pick<ResolvedEntityConfig, "memory" | "vaultSection">;

export interface EntityMcpWiringOptions {
	/** Entity-registry root (memory MCP `--registry`; also seeds `OMP_ENTITY_REGISTRY`). Default: {@link getEntityRegistryRoot}. */
	registryRoot?: string;
	/** Vault root the vault MCP operates on (absolute). Default: {@link resolveVaultRoot}. */
	vaultRoot?: string;
	/**
	 * Launch the servers via `bun run <module>` (source checkout) instead of the
	 * linked `omp-memory-mcp` / `omp-vault-mcp` bins. Default: {@link isDevCheckout}.
	 */
	dev?: boolean;
}

/** True in a source checkout (no compiled binary), where the linked MCP bins are absent. */
export function isDevCheckout(): boolean {
	return process.env.PI_COMPILED !== "true";
}

/** Resolve the shared vault root: `OMP_VAULT_PATH`, else the `~/vault` symlink. */
export function resolveVaultRoot(): string {
	const env = process.env[VAULT_PATH_ENV]?.trim();
	return env && env.length > 0 ? path.resolve(env) : path.join(os.homedir(), "vault");
}

/** Absolute path to the bundled memory MCP server entry module (dev fallback). */
export function memoryServerModulePath(): string {
	return fileURLToPath(new URL("../memory-mcp/server.ts", import.meta.url));
}

/** Absolute path to the bundled vault MCP server entry module (dev fallback). */
export function vaultServerModulePath(): string {
	return fileURLToPath(new URL("../vault-mcp/server.ts", import.meta.url));
}

function memoryServerConfig(bank: string, registryRoot: string, dev: boolean): MCPServerConfig {
	const flags = ["--registry", registryRoot, "--bank", bank];
	const env = { OMP_ENTITY_REGISTRY: registryRoot };
	return dev
		? { type: "stdio", command: "bun", args: ["run", memoryServerModulePath(), ...flags], env }
		: { type: "stdio", command: MEMORY_MCP_BIN, args: flags, env };
}

/**
 * Build the per-entity `mcpServers` map (memory + vault) for a resolved entity
 * config. Defaults resolve the registry root and vault root from the wired
 * environment (the symlinks/env WS7a setup establishes), so the daemon worker
 * can call this with just the config.
 */
export function buildEntityMcpServers(
	config: EntityMcpConfig,
	options: EntityMcpWiringOptions = {},
): Record<string, MCPServerConfig> {
	const dev = options.dev ?? isDevCheckout();
	const registryRoot = options.registryRoot ?? getEntityRegistryRoot();
	const vaultRoot = options.vaultRoot ?? resolveVaultRoot();

	const vault = vaultMcpServerConfig({
		vaultRoot,
		section: config.vaultSection,
		serverModule: dev ? vaultServerModulePath() : undefined,
	});

	return {
		[ENTITY_MCP_SERVER_NAMES.memory]: memoryServerConfig(config.memory.bank, registryRoot, dev),
		[ENTITY_MCP_SERVER_NAMES.vault]: {
			type: "stdio",
			command: vault.command,
			args: vault.args,
			...(vault.env ? { env: vault.env } : {}),
		},
	};
}
