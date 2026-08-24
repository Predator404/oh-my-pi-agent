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
import { type VaultMcpServerEntry, vaultMcpServerConfig } from "../vault-mcp/register";
import { getEntityRegistryRoot } from "./loader";
import { loadRegistryManifest, type RegistryAccess, type RegistryManifest, resolveRegistryAccess } from "./registries";
import type { ResolvedEntityConfig } from "./schema";

/** Default bin name for the WS3 bank-scoped memory MCP server. */
export const MEMORY_MCP_BIN = "omp-memory-mcp";

/** Environment variable pointing the vault MCP at the shared vault root (WS4). */
export const VAULT_PATH_ENV = "OMP_VAULT_PATH";

/** Server names an entity's worker registers. Stable so re-wiring overwrites, never duplicates. */
export const ENTITY_MCP_SERVER_NAMES = { memory: "memory", vault: "vault" } as const;

/** The C1 fields the wiring reads. */
export type EntityMcpConfig = Pick<ResolvedEntityConfig, "memory" | "vaultSection" | "registry">;

export interface EntityMcpWiringOptions {
	/** Legacy fallback: memory MCP `--registry` root when the manifest can't resolve. Default: {@link getEntityRegistryRoot}. */
	registryRoot?: string;
	/** Legacy fallback: single vault root when the manifest can't resolve. Default: {@link resolveVaultRoot}. */
	vaultRoot?: string;
	/** Preloaded registries manifest; skips {@link loadRegistryManifest}. */
	manifest?: RegistryManifest;
	/** Explicit registries manifest path (else env/default). Ignored when {@link manifest} is set. */
	manifestPath?: string;
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
 * Resolve the entity's registry access set (ADR 0004): the writable home root
 * followed by every readable root. Returns `undefined` when no manifest can be
 * loaded or the home id is unknown, so callers fall back to legacy single-root
 * wiring. A preloaded {@link EntityMcpWiringOptions.manifest} skips the load.
 */
async function resolveAccessSet(
	homeId: string,
	options: EntityMcpWiringOptions,
): Promise<RegistryAccess[] | undefined> {
	let manifest: RegistryManifest;
	try {
		manifest = options.manifest ?? (await loadRegistryManifest({ manifestPath: options.manifestPath }));
	} catch {
		return undefined;
	}
	try {
		return resolveRegistryAccess(manifest, homeId);
	} catch {
		return undefined;
	}
}

function toVaultServer(entry: VaultMcpServerEntry): MCPServerConfig {
	return {
		type: "stdio",
		command: entry.command,
		args: entry.args,
		...(entry.env ? { env: entry.env } : {}),
	};
}

/**
 * Build the per-entity `mcpServers` map (memory + vault) for a resolved entity
 * config. Resolves the registry manifest and, from the entity's home registry
 * id, the vault access set: the writable home root (`--vault` + `--section`)
 * plus every readable root (`--read id=root`), with memory records living in
 * the home root. When the manifest can't resolve the home id, falls back to the
 * legacy single-root wiring (`resolveVaultRoot` / `getEntityRegistryRoot`).
 */
export async function buildEntityMcpServers(
	config: EntityMcpConfig,
	options: EntityMcpWiringOptions = {},
): Promise<Record<string, MCPServerConfig>> {
	const dev = options.dev ?? isDevCheckout();
	const serverModule = dev ? vaultServerModulePath() : undefined;
	const access = await resolveAccessSet(config.registry, options);

	if (access) {
		const [home, ...readonlyRoots] = access;
		const vault = vaultMcpServerConfig({
			vaultRoot: home.root,
			section: config.vaultSection,
			homeId: config.registry,
			readableRoots: readonlyRoots.map(r => ({ id: r.id, root: r.root })),
			serverModule,
		});
		return {
			[ENTITY_MCP_SERVER_NAMES.memory]: memoryServerConfig(config.memory.bank, home.root, dev),
			[ENTITY_MCP_SERVER_NAMES.vault]: toVaultServer(vault),
		};
	}

	// Legacy fallback: single vault root + separate entity-registry root.
	const registryRoot = options.registryRoot ?? getEntityRegistryRoot();
	const vaultRoot = options.vaultRoot ?? resolveVaultRoot();
	const vault = vaultMcpServerConfig({ vaultRoot, section: config.vaultSection, serverModule });
	return {
		[ENTITY_MCP_SERVER_NAMES.memory]: memoryServerConfig(config.memory.bank, registryRoot, dev),
		[ENTITY_MCP_SERVER_NAMES.vault]: toVaultServer(vault),
	};
}
