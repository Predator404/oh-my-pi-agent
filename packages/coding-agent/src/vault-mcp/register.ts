/**
 * Registration helper: build the `.omp/mcp.json` entry that launches a
 * per-entity vault MCP server (SPEC §7, §12.4).
 *
 * An entity's C1 record carries a `vaultSection` (e.g. `agents/phi`). The
 * resolved config binds a stdio server to the shared vault root, defaulting
 * writes/search to that section. WS7's config surface / the daemon worker wires
 * one of these per entity into the session's MCP servers.
 */
import { fileURLToPath } from "node:url";

/** Minimal stdio MCP server entry, matching the `.omp/mcp.json` server shape. */
export interface VaultMcpServerEntry {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

/** Inputs for {@link vaultMcpServerConfig}. */
export interface VaultMcpServerConfigOptions {
	/** Vault root the server operates on (absolute); omit to use OMP_VAULT_PATH/~/vault. */
	vaultRoot?: string;
	/** Owning section (a C1 record's vaultSection), the default search/write scope. */
	section?: string;
	/**
	 * Dev-checkout fallback: absolute path to the server entry module. When set,
	 * the entry launches `bun run <serverModule>` instead of the linked
	 * `omp-vault-mcp` bin (mirrors WS3's memory-server convention).
	 */
	serverModule?: string;
	/** Override the launcher command (defaults to `omp-vault-mcp`, or `bun` in dev). */
	command?: string;
}

/** Absolute path to the bundled vault MCP server entry module. */
export function vaultServerModulePath(): string {
	return fileURLToPath(new URL("./server.ts", import.meta.url));
}

/**
 * Produce the stdio server entry for an entity. The returned object is dropped
 * under `mcpServers.<name>` in an `.omp/mcp.json` file. By default it invokes
 * the linked `omp-vault-mcp` bin; pass `serverModule` for a dev checkout where
 * the bin is not on PATH.
 */
export function vaultMcpServerConfig(options: VaultMcpServerConfigOptions = {}): VaultMcpServerEntry {
	const flags: string[] = [];
	if (options.vaultRoot) flags.push("--vault", options.vaultRoot);
	if (options.section) flags.push("--section", options.section);
	if (options.serverModule) {
		return { command: options.command ?? "bun", args: ["run", options.serverModule, ...flags] };
	}
	return { command: options.command ?? "omp-vault-mcp", args: flags };
}
