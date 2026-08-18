/**
 * C2 memory MCP tool contract: `recall`, `retain`, `forget` (SPEC §6, §12.3).
 *
 * Every tool takes an explicit `bank` — the argument is authoritative, which is
 * what lets one running server address distinct banks concurrently. The write
 * path (`retain`) is where the agent-vs-persona retention policy is enforced:
 * an `auto` (episodic) write is rejected unless the bank is auto-retainable;
 * `deliberate` writes always pass, so a persona still curates lessons on
 * explicit calls.
 */
import type { BankStore, RetainMode } from "./bank-store";
import type { BankPolicyRegistry } from "./policy";

export type ToolArguments = Record<string, unknown>;
export type ToolResult = Record<string, unknown>;

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: {
		readonly type: "object";
		readonly properties: Record<string, unknown>;
		readonly required?: readonly string[];
	};
}

/** Runtime dependencies the tool handlers act on. */
export interface ToolContext {
	readonly store: BankStore;
	readonly policy: BankPolicyRegistry;
	/**
	 * Bank used when a tool call omits `bank` — the per-entity binding a worker
	 * pins via `--bank`/`OMP_MEMORY_BANK` so a session addresses its own bank
	 * without the model repeating it. An explicit `bank` argument still wins.
	 */
	readonly defaultBank?: string;
}

/** A `retain` was rejected because the bank is curated-only (persona-tier). */
export class RetentionPolicyError extends Error {
	override name = "RetentionPolicyError";
}

export const RECALL_SCHEMA = {
	type: "object",
	properties: {
		bank: {
			type: "string",
			description: "Memory bank to search. Defaults to the server's configured bank when omitted.",
		},
		query: { type: "string", description: "Natural-language search query." },
		k: { type: "integer", description: "Maximum results to return.", default: 5, minimum: 1 },
	},
	required: ["query"],
} as const;

export const RETAIN_SCHEMA = {
	type: "object",
	properties: {
		bank: {
			type: "string",
			description: "Memory bank to write into. Defaults to the server's configured bank when omitted.",
		},
		memory: { type: "string", description: "The memory content to store." },
		context: { type: "string", description: "Optional surrounding context stored with the memory." },
		mode: {
			type: "string",
			enum: ["deliberate", "auto"],
			default: "deliberate",
			description:
				"'deliberate' = an explicit, curated write (always allowed). 'auto' = automatic episodic capture; " +
				"permitted only for auto-retaining (agent-tier) banks. A curated-only (persona) bank rejects 'auto'.",
		},
	},
	required: ["memory"],
} as const;

export const FORGET_SCHEMA = {
	type: "object",
	properties: {
		bank: {
			type: "string",
			description: "Memory bank to delete from. Defaults to the server's configured bank when omitted.",
		},
		id: { type: "string", description: "Id of the memory to remove." },
	},
	required: ["id"],
} as const;

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
	{
		name: "recall",
		description: "Search a memory bank for memories relevant to a query. Returns scoped results ranked by relevance.",
		inputSchema: RECALL_SCHEMA,
	},
	{
		name: "retain",
		description:
			"Store a memory in a bank and return its id. Use mode 'deliberate' (default) for curated lessons; " +
			"'auto' is for automatic episodic capture and is rejected on curated-only (persona) banks.",
		inputSchema: RETAIN_SCHEMA,
	},
	{
		name: "forget",
		description: "Remove a memory from a bank by id.",
		inputSchema: FORGET_SCHEMA,
	},
];

export function getToolDefinitions(): readonly ToolDefinition[] {
	return TOOL_DEFINITIONS;
}

function requireString(args: ToolArguments, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`"${key}" is required and must be a non-empty string`);
	}
	return value;
}

function optString(args: ToolArguments, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`"${key}" must be a string`);
	return value;
}

function parseK(args: ToolArguments): number {
	const value = args.k;
	if (value === undefined || value === null) return 5;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`"k" must be a positive integer`);
	}
	return value;
}

function parseMode(args: ToolArguments): RetainMode {
	const value = args.mode;
	if (value === undefined || value === null) return "deliberate";
	if (value !== "deliberate" && value !== "auto") throw new Error(`"mode" must be "deliberate" or "auto"`);
	return value;
}

/** The explicit `bank` argument, else the context default, else an error. */
function resolveBank(args: ToolArguments, ctx: ToolContext): string {
	const explicit = optString(args, "bank");
	if (explicit !== undefined && explicit.length > 0) return explicit;
	if (ctx.defaultBank !== undefined && ctx.defaultBank.length > 0) return ctx.defaultBank;
	throw new Error(`"bank" is required (no default bank is configured on this server)`);
}

export async function handleToolCall(name: string, args: ToolArguments, ctx: ToolContext): Promise<ToolResult> {
	switch (name) {
		case "recall": {
			const bank = resolveBank(args, ctx);
			const query = requireString(args, "query");
			const results = await ctx.store.recall(bank, query, parseK(args));
			return { bank, query, count: results.length, results };
		}
		case "retain": {
			const bank = resolveBank(args, ctx);
			const memory = requireString(args, "memory");
			const context = optString(args, "context");
			const mode = parseMode(args);
			if (mode === "auto") {
				const decision = await ctx.policy.decideAutoRetain(bank);
				if (!decision.allowed) throw new RetentionPolicyError(decision.message);
			}
			const id = ctx.store.retain(bank, memory, { context, mode });
			return { id, bank, mode };
		}
		case "forget": {
			const bank = resolveBank(args, ctx);
			const id = requireString(args, "id");
			return { bank, id, removed: ctx.store.forget(bank, id) };
		}
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}
