/**
 * Reader for Smart Connections' locally-stored embeddings (SPEC §7.1).
 *
 * Smart Connections (the Obsidian community plugin) computes embeddings
 * on-device and persists them inside the vault under `.smart-env/`:
 *   - `.smart-env/smart_env.json` — environment config incl. the embed model.
 *   - `.smart-env/multi/*.ajson`  — one "append-JSON" file per note holding
 *     `smart_sources:` (file-level) and `smart_blocks:` (section-level) entries,
 *     each carrying an `embeddings[<modelKey>].vec` vector.
 *
 * This module ONLY reads that store — it never contacts a network service, so
 * the semantic read path is entirely local. Block granularity is preserved so
 * `search_notes` can return block-level hits (SPEC §12.4 acceptance).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { modelDimensions } from "./embedder";

/** A single embedded unit from the store: a whole file or one block within it. */
export interface EmbeddingEntry {
	/** Store key: `<file>` for a source, `<file>#<breadcrumb>` for a block. */
	key: string;
	/** Owning note path, vault-relative (block keys stripped of `#…`). */
	filePath: string;
	/** Sub-key for a block (the `#…` breadcrumb), undefined for a source. */
	subKey?: string;
	/** The stored embedding vector. */
	vec: number[];
	kind: "source" | "block";
	/** Line range `[start, end]` (1-based, inclusive) when the store records it. */
	lines?: [number, number];
}

/** Embed-model metadata read from `smart_env.json`. */
export interface ModelInfo {
	modelKey: string;
	dimensions: number;
}

/** Parsed Smart Connections store for one vault. */
export interface SmartConnectionsStore {
	entries: Map<string, EmbeddingEntry>;
	model: ModelInfo;
}

interface AjsonBlockInfo {
	lines?: [number, number];
}

interface AjsonEntry {
	embeddings?: Record<string, { vec?: unknown } | undefined>;
	blocks?: Record<string, AjsonBlockInfo | undefined>;
	lines?: [number, number];
}

const SMART_ENV_DIR = ".smart-env";
const MULTI_DIR = "multi";
const CONFIG_FILE = "smart_env.json";

/** Absolute path to a vault's `.smart-env` directory. */
export function smartEnvPath(vaultRoot: string): string {
	return path.join(vaultRoot, SMART_ENV_DIR);
}

function readModelInfo(envDir: string): ModelInfo {
	const configPath = path.join(envDir, CONFIG_FILE);
	let modelKey = "TaylorAI/bge-micro-v2";
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
			smart_sources?: { embed_model?: { transformers?: { model_key?: unknown } } };
		};
		const key = parsed.smart_sources?.embed_model?.transformers?.model_key;
		if (typeof key === "string" && key.length > 0) modelKey = key;
	} catch {
		// Missing/invalid config → fall back to Smart Connections' default model.
	}
	return { modelKey, dimensions: modelDimensions(modelKey) };
}

/**
 * Parse one `.ajson` file. Its body is a comma-separated sequence of
 * `"key": {…}` members (append-JSON); wrapping in braces yields valid JSON.
 */
function parseAjson(filePath: string, modelKey: string, out: Map<string, EmbeddingEntry>): void {
	let raw = fs.readFileSync(filePath, "utf8").trim();
	if (raw.length === 0) return;
	if (raw.endsWith(",")) raw = raw.slice(0, -1);
	let parsed: Record<string, AjsonEntry>;
	try {
		parsed = JSON.parse(`{${raw}}`) as Record<string, AjsonEntry>;
	} catch {
		return; // Skip a corrupt shard rather than fail the whole load.
	}
	for (const [fullKey, value] of Object.entries(parsed)) {
		let kind: "source" | "block";
		let entryKey: string;
		if (fullKey.startsWith("smart_sources:")) {
			kind = "source";
			entryKey = fullKey.slice("smart_sources:".length);
		} else if (fullKey.startsWith("smart_blocks:")) {
			kind = "block";
			entryKey = fullKey.slice("smart_blocks:".length);
		} else {
			continue;
		}
		const vec = value?.embeddings?.[modelKey]?.vec;
		if (!Array.isArray(vec) || vec.length === 0) continue;
		const hashIdx = entryKey.indexOf("#");
		const filePathRel = hashIdx >= 0 ? entryKey.slice(0, hashIdx) : entryKey;
		const subKey = hashIdx >= 0 ? entryKey.slice(hashIdx) : undefined;
		const entry: EmbeddingEntry = {
			key: entryKey,
			filePath: filePathRel,
			subKey,
			vec: vec as number[],
			kind,
		};
		if (Array.isArray(value.lines) && value.lines.length === 2) {
			entry.lines = [value.lines[0], value.lines[1]];
		}
		out.set(entryKey, entry);
	}
	// Second pass: source `blocks` maps carry line ranges for their blocks.
	for (const [fullKey, value] of Object.entries(parsed)) {
		if (!fullKey.startsWith("smart_sources:") || !value.blocks) continue;
		const sourcePath = fullKey.slice("smart_sources:".length);
		for (const [sub, info] of Object.entries(value.blocks)) {
			const blockEntry = out.get(`${sourcePath}${sub}`);
			if (blockEntry && !blockEntry.lines && info?.lines && info.lines.length === 2) {
				blockEntry.lines = [info.lines[0], info.lines[1]];
			}
		}
	}
}

/**
 * Load a vault's Smart Connections embedding store. Returns an empty entry map
 * (never throws) when the vault has not been indexed yet.
 */
export function loadSmartConnectionsStore(vaultRoot: string): SmartConnectionsStore {
	const envDir = smartEnvPath(vaultRoot);
	const model = readModelInfo(envDir);
	const entries = new Map<string, EmbeddingEntry>();
	const multiDir = path.join(envDir, MULTI_DIR);
	let files: string[];
	try {
		files = fs.readdirSync(multiDir).filter(f => f.endsWith(".ajson"));
	} catch {
		return { entries, model };
	}
	for (const file of files) {
		try {
			parseAjson(path.join(multiDir, file), model.modelKey, entries);
		} catch {
			// Skip unreadable shard.
		}
	}
	return { entries, model };
}
