/**
 * Vault + MCP bridge — contract C3 (SPEC §7, §12.4).
 *
 * A per-entity stdio MCP server exposing vault retrieval:
 *   - text-grep search over vault markdown (mnemopi recall when available),
 *   - Obsidian wikilink/backlink graph traversal via regex scan,
 *   - plain-file markdown reads/writes scoped to the entity's vault section.
 *
 * Embedding, graph, and store modules deleted — those responsibilities are
 * now handled by mnemopi (embeddings/vector search) and the vault:// protocol
 * handler (Obsidian CLI wikilink resolution).
 *
 * Nothing here makes a cloud call.
 */
// embedder.ts deleted — embeddings delegated to mnemopi.
// graph.ts deleted — wikilink resolution via regex scan in vault.ts (vault:// handler preferred).
// store.ts deleted — embedding storage handled by mnemopi.
// register.ts deleted — VaultMcpServerEntry, vaultMcpServerConfig inlined into entity/mcp-wiring.ts.
export { bridgeFromArgv, callTool, handleJsonRpc, listTools, main, runStdio } from "./server";
export {
	GET_CONNECTIONS_SCHEMA,
	GET_NOTE_SCHEMA,
	getToolDefinitions,
	handleToolCall,
	SEARCH_NOTES_SCHEMA,
	type ToolArguments,
	type ToolDefinition,
	type ToolResult,
	WRITE_NOTE_SCHEMA,
} from "./tools";
export {
	type Connections,
	type NoteHit,
	type ReadonlyRoot,
	resolveVaultRoot,
	VaultBridge,
	type VaultBridgeOptions,
} from "./vault";
