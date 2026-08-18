/**
 * Vault MCP server — line-delimited JSON-RPC 2.0 over stdio (SPEC §7, §12.4).
 *
 * Mirrors the mnemopi MCP server transport (`packages/mnemopi/src/mcp-server.ts`):
 * one JSON-RPC message per line, handling `initialize`, `tools/list`, and
 * `tools/call`. The server is bound to a {@link VaultBridge} resolved from CLI
 * args (`--vault <root>`, `--section <vaultSection>`) or environment.
 *
 * Registered as a per-entity stdio MCP server (see {@link vaultMcpServerConfig}).
 */
import { TransformersEmbedder } from "./embedder";
import { loadSmartConnectionsStore } from "./store";
import { getToolDefinitions, handleToolCall, type ToolArguments, type ToolDefinition } from "./tools";
import { resolveVaultRoot, VaultBridge } from "./vault";

export interface JsonRpcRequest {
	readonly jsonrpc?: string;
	readonly id?: string | number | null;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	readonly jsonrpc: "2.0";
	readonly id: string | number | null;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

export interface CallToolResponse {
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly isError?: boolean;
}

export interface WritableOutput {
	write(chunk: string): unknown;
}

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_VERSION = "0.1.0";

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function requestId(request: JsonRpcRequest): string | number | null {
	return typeof request.id === "string" || typeof request.id === "number" || request.id === null ? request.id : null;
}

export function listTools(): { tools: readonly ToolDefinition[] } {
	return { tools: getToolDefinitions() };
}

export async function callTool(bridge: VaultBridge, name: string, args: ToolArguments = {}): Promise<CallToolResponse> {
	try {
		const result = await handleToolCall(bridge, name, args);
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: JSON.stringify({ status: "error", message }, null, 2) }],
			isError: true,
		};
	}
}

/** Handle one JSON-RPC request. Returns null for notifications (no reply). */
export async function handleJsonRpc(bridge: VaultBridge, request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
	const method = request.method ?? "";
	if (method.startsWith("notifications/") || !Object.hasOwn(request, "id")) return null;
	const id = requestId(request);
	if (method === "initialize") {
		return ok(id, {
			protocolVersion: PROTOCOL_VERSION,
			serverInfo: { name: "omp-vault", version: SERVER_VERSION },
			capabilities: { tools: {} },
		});
	}
	if (method === "tools/list") return ok(id, listTools());
	if (method === "tools/call") {
		const params = request.params ?? {};
		const name = typeof params.name === "string" ? params.name : "";
		const args =
			params.arguments !== null && typeof params.arguments === "object" && !Array.isArray(params.arguments)
				? (params.arguments as ToolArguments)
				: {};
		if (name.length === 0) return err(id, -32602, "tools/call requires params.name");
		return ok(id, await callTool(bridge, name, args));
	}
	return err(id, -32601, `Unknown method: ${method}`);
}

export async function runStdio(
	bridge: VaultBridge,
	input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
	output: WritableOutput = Bun.stdout,
): Promise<void> {
	const reader = input.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length > 0) {
					let parsed: unknown;
					try {
						parsed = JSON.parse(line);
					} catch {
						output.write(`${JSON.stringify(err(null, -32700, "Parse error"))}\n`);
						newline = buffer.indexOf("\n");
						continue;
					}
					const response = await handleJsonRpc(bridge, parsed as JsonRpcRequest);
					if (response !== null) output.write(`${JSON.stringify(response)}\n`);
				}
				newline = buffer.indexOf("\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/** CLI args → VaultBridge. `--vault <root>` and `--section <vaultSection>`. */
export function bridgeFromArgv(argv: readonly string[]): VaultBridge {
	let vault: string | undefined;
	let section: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--vault") vault = argv[++i];
		else if (argv[i] === "--section") section = argv[++i];
	}
	return new VaultBridge({ vaultRoot: resolveVaultRoot(vault), section });
}

/**
 * Prefetch the vault's embedding model into the local cache, then exit. This is
 * the deterministic, network-using warm step (`omp-vault-mcp --warm-cache`) that
 * WS7a's filesystem-only setup deliberately does not perform. It embeds a probe
 * string with the model recorded in the vault's Smart Connections store (default
 * bge-micro-v2), forcing the one-time download so later searches run offline.
 */
export async function warmCache(argv: readonly string[], log: WritableOutput = Bun.stdout): Promise<void> {
	let vault: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--vault") vault = argv[++i];
	}
	const vaultRoot = resolveVaultRoot(vault);
	const store = loadSmartConnectionsStore(vaultRoot);
	const embedder = new TransformersEmbedder(store.model.modelKey, { offline: false });
	log.write(`Warming embedding model '${store.model.modelKey}' for vault ${vaultRoot} …\n`);
	await embedder.embed("vault embedding model warm-up probe");
	log.write(`Done. Model cached; searches can now run offline (set OMP_VAULT_EMBED_OFFLINE=1).\n`);
}

export function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<void> {
	if (argv.includes("--warm-cache")) return warmCache(argv);
	return runStdio(bridgeFromArgv(argv));
}

if (import.meta.main) await main();
