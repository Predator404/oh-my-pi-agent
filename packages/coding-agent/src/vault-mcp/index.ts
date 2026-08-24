/**
 * Vault + MCP bridge — contract C3 (SPEC §7, §12.4).
 *
 * A per-entity stdio MCP server exposing hybrid vault retrieval:
 *   - vector/semantic read via Smart Connections' locally-stored embeddings,
 *   - Obsidian wikilink/backlink graph traversal,
 *   - plain-file markdown reads/writes scoped to the entity's vault section.
 *
 * Nothing here makes a cloud call.
 */
export {
	cosineSimilarity,
	DEFAULT_EMBED_MODEL,
	type Embedder,
	modelDimensions,
	TransformersEmbedder,
} from "./embedder";
export { type Backlink, type ForwardLink, VaultGraph } from "./graph";
export {
	type VaultMcpServerEntry,
	type VaultReadableRoot,
	vaultMcpServerConfig,
	vaultServerModulePath,
} from "./register";
export { bridgeFromArgv, callTool, handleJsonRpc, listTools, main, runStdio, warmCache } from "./server";
export {
	type EmbeddingEntry,
	loadSmartConnectionsStore,
	type ModelInfo,
	type SmartConnectionsStore,
	smartEnvPath,
} from "./store";
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
