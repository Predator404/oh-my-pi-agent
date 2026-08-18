#!/usr/bin/env bun
/**
 * Bank-scoped memory MCP server (contract C2, SPEC §12.3).
 *
 * A standalone stdio JSON-RPC 2.0 server — the same line-delimited protocol
 * mnemopi's own MCP server speaks (`packages/mnemopi/src/mcp-server.ts`) — that
 * wraps a {@link BankStore} (one live mnemopi per bank) and a
 * {@link BankPolicyRegistry} (C1-derived write policy). Because every C2 tool
 * carries an explicit `bank`, one running server addresses many banks at once,
 * closing OMP's one-backend-per-session gap.
 *
 * Register it via the `.omp/mcp.json` convention as a stdio server, e.g.:
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "memory": {
 *       "command": "omp-memory-mcp",
 *       "env": { "OMP_ENTITY_REGISTRY": "/path/to/registry" }
 *     }
 *   }
 * }
 * ```
 */
import { BankStore, type BankStoreOptions } from "./bank-store";
import { BankPolicyRegistry } from "./policy";
import { getToolDefinitions, handleToolCall, type ToolArguments, type ToolContext } from "./tools";

export const SERVER_NAME = "omp-memory";
export const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string };
}

export interface WritableOutput {
	write(chunk: string): unknown;
}

export interface MemoryMcpServerOptions extends BankStoreOptions {
	/** Explicit entity-registry root; overrides `OMP_ENTITY_REGISTRY` and the default. */
	registryRoot?: string;
	/**
	 * Bank a tool call defaults to when it omits `bank` — the per-entity binding
	 * (`--bank` / `OMP_MEMORY_BANK`). An explicit `bank` argument still wins.
	 */
	defaultBank?: string;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function requestId(request: JsonRpcRequest): string | number | null {
	const { id } = request;
	return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

/**
 * A live C2 memory server bound to a {@link BankStore} + {@link BankPolicyRegistry}.
 * Holds the per-bank connections open for its lifetime, so it must be
 * {@link MemoryMcpServer.close}d when done.
 */
export class MemoryMcpServer {
	readonly store: BankStore;
	readonly policy: BankPolicyRegistry;
	readonly #ctx: ToolContext;

	constructor(options: MemoryMcpServerOptions = {}) {
		this.store = new BankStore(options);
		this.policy = new BankPolicyRegistry({ registryRoot: options.registryRoot });
		this.#ctx = { store: this.store, policy: this.policy, defaultBank: options.defaultBank };
	}

	/** Execute one tool call, returning MCP `CallToolResult` content. */
	async callTool(name: string, args: ToolArguments = {}): Promise<Record<string, unknown>> {
		try {
			const result = await handleToolCall(name, args, this.#ctx);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: JSON.stringify({ status: "error", message }, null, 2) }],
				isError: true,
			};
		}
	}

	/** Handle one JSON-RPC request; returns `null` for notifications (no reply). */
	async handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
		const method = request.method ?? "";
		if (method.startsWith("notifications/") || !Object.hasOwn(request, "id")) return null;
		const id = requestId(request);
		if (method === "initialize") {
			return ok(id, {
				protocolVersion: PROTOCOL_VERSION,
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
				capabilities: { tools: {} },
			});
		}
		if (method === "tools/list") return ok(id, { tools: getToolDefinitions() });
		if (method === "tools/call") {
			const params = request.params ?? {};
			const name = typeof params.name === "string" ? params.name : "";
			const rawArgs = params.arguments;
			const args =
				rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
					? (rawArgs as ToolArguments)
					: {};
			if (name.length === 0) return err(id, -32602, "tools/call requires params.name");
			return ok(id, await this.callTool(name, args));
		}
		return err(id, -32601, `Unknown method: ${method}`);
	}

	/** Read line-delimited JSON-RPC from `input`, writing responses to `output`. */
	async runStdio(
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
						const response = await this.handleJsonRpc(parsed as JsonRpcRequest);
						if (response !== null) output.write(`${JSON.stringify(response)}\n`);
					}
					newline = buffer.indexOf("\n");
				}
			}
		} finally {
			reader.releaseLock();
			this.store.close();
		}
	}

	close(): void {
		this.store.close();
	}
}

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<void> {
	const options: MemoryMcpServerOptions = {};
	const envBank = process.env.OMP_MEMORY_BANK;
	if (envBank !== undefined && envBank.length > 0) options.defaultBank = envBank;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--registry") options.registryRoot = argv[++i] ?? "";
		else if (arg === "--data-dir") options.dataDir = argv[++i] ?? "";
		else if (arg === "--bank") options.defaultBank = argv[++i] ?? "";
		else if (arg === "--no-embeddings") options.noEmbeddings = true;
	}
	const server = new MemoryMcpServer(options);
	await server.runStdio();
}

if (import.meta.main) await main();
