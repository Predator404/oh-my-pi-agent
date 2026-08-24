/**
 * C3 vault MCP tool surface (SPEC §6, §12.4).
 *
 * Four tools, exposed over MCP `tools/list` + `tools/call`:
 *   - `search_notes(section?, query, k?)` → block-level semantic hits, scoped.
 *   - `get_note(path)`                    → note markdown.
 *   - `write_note(path, content)`         → plain-file write into the section.
 *   - `get_connections(path)`             → wikilink/backlink traversal.
 *
 * Dispatch is pure over a {@link VaultBridge}, so the server and the tests share
 * one code path.
 */
import type { VaultBridge } from "./vault";

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

export const SEARCH_NOTES_SCHEMA = {
	type: "object",
	properties: {
		query: { type: "string", description: "Natural-language query embedded on-device for semantic ranking." },
		section: {
			type: "string",
			description:
				"Vault subtree to scope results to (e.g. 'agents/phi'). Defaults to the entity's owning section, then the whole vault.",
		},
		k: { type: "integer", description: "Max number of block-level hits to return.", default: 5 },
		registry: {
			type: "string",
			description: "Registry id to read from; defaults to the entity's home registry.",
		},
	},
	required: ["query"],
} as const;

export const GET_NOTE_SCHEMA = {
	type: "object",
	properties: {
		path: { type: "string", description: "Vault-relative (or in-vault absolute) path to a markdown note." },
		registry: { type: "string", description: "Registry id to read from; defaults to home." },
	},
	required: ["path"],
} as const;

export const WRITE_NOTE_SCHEMA = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description:
				"Note path. A bare relative path lands under the entity's owning section; include a section prefix to target another subtree.",
		},
		content: { type: "string", description: "Full markdown content to write." },
	},
	required: ["path", "content"],
} as const;

export const GET_CONNECTIONS_SCHEMA = {
	type: "object",
	properties: {
		path: { type: "string", description: "Vault-relative path of the entry note to traverse links from." },
		registry: { type: "string", description: "Registry id to read from; defaults to home." },
	},
	required: ["path"],
} as const;

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
	{
		name: "search_notes",
		description:
			"Semantic search over the vault's Smart Connections embeddings (on-device, no cloud). Returns block-level hits scoped to a section.",
		inputSchema: SEARCH_NOTES_SCHEMA,
	},
	{
		name: "get_note",
		description: "Read the markdown content of a note in the vault.",
		inputSchema: GET_NOTE_SCHEMA,
	},
	{
		name: "write_note",
		description: "Write markdown to a note in the vault (plain file write into the correct section).",
		inputSchema: WRITE_NOTE_SCHEMA,
	},
	{
		name: "get_connections",
		description: "Traverse a note's Obsidian wikilink/backlink graph (plus its nearest vector neighbors).",
		inputSchema: GET_CONNECTIONS_SCHEMA,
	},
];

export function getToolDefinitions(): readonly ToolDefinition[] {
	return TOOL_DEFINITIONS;
}

function requireString(args: ToolArguments, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`'${key}' must be a non-empty string`);
	return value;
}

function optionalString(args: ToolArguments, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Dispatch one C3 tool call against a bound vault bridge. */
export async function handleToolCall(bridge: VaultBridge, name: string, args: ToolArguments = {}): Promise<ToolResult> {
	switch (name) {
		case "search_notes": {
			const query = requireString(args, "query");
			const section = optionalString(args, "section");
			const registry = optionalString(args, "registry");
			const k = typeof args.k === "number" ? args.k : undefined;
			const hits = await bridge.searchNotes(query, { section, k, registry });
			return { section: section ?? bridge.section ?? null, count: hits.length, hits };
		}
		case "get_note":
			return bridge.getNote(requireString(args, "path"), optionalString(args, "registry"));
		case "write_note":
			return bridge.writeNote(requireString(args, "path"), typeof args.content === "string" ? args.content : "");
		case "get_connections": {
			const conn = bridge.getConnections(requireString(args, "path"), optionalString(args, "registry"));
			return {
				file: conn.file,
				linksOut: conn.linksOut,
				linksIn: conn.linksIn,
				relatedByVector: conn.relatedByVector,
			};
		}
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}
