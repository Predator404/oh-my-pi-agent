/**
 * VaultBridge — the C3 vault operations behind the MCP server (SPEC §7, §12.4).
 *
 * One bridge is bound to one vault root and (optionally) one owning section
 * (a C1 record's `vaultSection`, e.g. `agents/phi`). It exposes the four C3
 * primitives:
 *   - {@link searchNotes}     hybrid semantic search → block-level hits, scoped.
 *   - {@link getNote}         read a note's markdown.
 *   - {@link writeNote}       plain-file write into the correct section.
 *   - {@link getConnections}  wikilink/backlink traversal (+ vector neighbors).
 *
 * All filesystem access is confined to the vault root (no `..` escape, no
 * symlink break-out). Nothing here contacts the network: semantic ranking reads
 * Smart Connections' local store and embeds the query with an on-device model.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cosineSimilarity, type Embedder, TransformersEmbedder } from "./embedder";
import { VaultGraph } from "./graph";
import { type EmbeddingEntry, loadSmartConnectionsStore, type SmartConnectionsStore } from "./store";

/** A block-level semantic search hit. */
export interface NoteHit {
	/** Store key: `<file>` or `<file>#<breadcrumb>`. */
	key: string;
	/** Vault-relative note path. */
	file: string;
	/** Heading breadcrumb for a block hit. */
	heading?: string;
	/** Cosine similarity to the query (0..1). */
	score: number;
	/** Line range in the note, when known. */
	lines?: [number, number];
	/** The matched block/note text (bounded). */
	text: string;
	/** Whether this was a block-level or whole-file hit. */
	granularity: "block" | "source";
}

/** Result of a connections traversal. */
export interface Connections {
	file: string;
	linksOut: { target: string; resolved?: string; heading?: string }[];
	linksIn: { source: string }[];
	/** Semantically-nearest OTHER notes (vector neighbors of this note). */
	relatedByVector: { file: string; score: number }[];
}

/** Options controlling {@link VaultBridge} construction. */
export interface VaultBridgeOptions {
	/** Absolute vault root. */
	vaultRoot: string;
	/** Owning section (vault-relative), default scope for search/write. */
	section?: string;
	/** Injected embedder; defaults to on-device {@link TransformersEmbedder}. */
	embedder?: Embedder;
}

const MAX_HIT_CHARS = 2000;
const DEFAULT_TOP_K = 5;
const DEFAULT_RELATED = 5;

/** Standard top-level vault subtrees (SPEC §4.3). A path opening with one of
 * these is treated as vault-relative rather than nested under an entity section. */
const KNOWN_SECTION_ROOTS: readonly string[] = ["agents", "personas", "projects"];

/**
 * Resolve the vault root: explicit path > `OMP_VAULT_PATH` > the `~/vault`
 * symlink convention (SPEC §7.3). Returned path is absolute and normalized.
 */
export function resolveVaultRoot(explicit?: string): string {
	const raw = explicit ?? process.env.OMP_VAULT_PATH ?? path.join(os.homedir(), "vault");
	return path.resolve(raw);
}

function normalizeSection(section: string | undefined): string | undefined {
	if (!section) return undefined;
	const trimmed = section.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "");
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Canonicalize a vault root: absolute + symlinks resolved, so path-confinement
 * comparisons hold even when the root sits under a symlinked prefix (e.g. macOS
 * `/var` → `/private/var`, or the `~/vault` symlink itself). Falls back to a
 * plain resolve when the root does not yet exist.
 */
function canonicalRoot(root: string): string {
	const abs = path.resolve(root);
	try {
		return fs.realpathSync(abs);
	} catch {
		return abs;
	}
}

export class VaultBridge {
	readonly vaultRoot: string;
	readonly section?: string;
	private readonly injectedEmbedder?: Embedder;
	private defaultEmbedder: Embedder | null = null;
	private storeCache: SmartConnectionsStore | null = null;
	private graphCache: VaultGraph | null = null;

	constructor(options: VaultBridgeOptions) {
		this.vaultRoot = canonicalRoot(options.vaultRoot);
		this.section = normalizeSection(options.section);
		this.injectedEmbedder = options.embedder;
	}

	/**
	 * Confine a caller-supplied path to the vault. Relative paths that do not
	 * already name a top-level vault subtree are rooted at the bridge's section
	 * (so an entity's writes/reads default to its own area). Throws on escape.
	 */
	resolveInVault(relOrAbs: string, opts?: { rootInSection?: boolean }): { abs: string; rel: string } {
		const cleaned = relOrAbs.trim();
		if (cleaned.length === 0) throw new Error("Empty note path");
		let candidate: string;
		if (path.isAbsolute(cleaned)) {
			candidate = path.resolve(cleaned);
		} else {
			const firstSeg = cleaned.split(/[/\\]/, 1)[0];
			const sectionRoot = this.section?.split("/", 1)[0];
			const namesSection =
				KNOWN_SECTION_ROOTS.includes(firstSeg) || (sectionRoot !== undefined && firstSeg === sectionRoot);
			const base =
				opts?.rootInSection && this.section && !namesSection
					? path.join(this.vaultRoot, this.section)
					: this.vaultRoot;
			candidate = path.resolve(base, cleaned);
		}
		const rootWithSep = this.vaultRoot.endsWith(path.sep) ? this.vaultRoot : this.vaultRoot + path.sep;
		const real = this.realExistingPrefix(candidate);
		if (real !== this.vaultRoot && !real.startsWith(rootWithSep)) {
			throw new Error(`Path escapes vault root: ${relOrAbs}`);
		}
		if (candidate !== this.vaultRoot && !candidate.startsWith(rootWithSep)) {
			throw new Error(`Path escapes vault root: ${relOrAbs}`);
		}
		return { abs: candidate, rel: path.relative(this.vaultRoot, candidate) };
	}

	/** realpath of the deepest existing ancestor (defends against symlink escape). */
	private realExistingPrefix(candidate: string): string {
		let cur = candidate;
		while (true) {
			try {
				return fs.realpathSync(cur);
			} catch {
				const parent = path.dirname(cur);
				if (parent === cur) return cur;
				cur = parent;
			}
		}
	}

	private store(): SmartConnectionsStore {
		if (!this.storeCache) this.storeCache = loadSmartConnectionsStore(this.vaultRoot);
		return this.storeCache;
	}

	private graph(): VaultGraph {
		if (!this.graphCache) this.graphCache = new VaultGraph(this.vaultRoot).build();
		return this.graphCache;
	}

	/** Force a reload of the embedding store + link graph (after external writes). */
	invalidate(): void {
		this.storeCache = null;
		this.graphCache = null;
	}

	/**
	 * Choose the query embedder so it matches the model that produced the store's
	 * vectors — ranking across mismatched models is meaningless (cosine over
	 * differently-dimensioned/differently-trained vectors). An injected embedder
	 * MUST match the store model (hard error otherwise); the default embedder is
	 * built lazily from the store's recorded model key.
	 */
	private embedderFor(store: SmartConnectionsStore): Embedder {
		const storeModel = store.model.modelKey;
		if (this.injectedEmbedder) {
			if (this.injectedEmbedder.modelKey !== storeModel) {
				throw new Error(
					`Query embedder model '${this.injectedEmbedder.modelKey}' does not match the vault's stored embedding model '${storeModel}'; semantic rankings would be meaningless. Provide an embedder for '${storeModel}'.`,
				);
			}
			return this.injectedEmbedder;
		}
		if (!this.defaultEmbedder || this.defaultEmbedder.modelKey !== storeModel) {
			this.defaultEmbedder = new TransformersEmbedder(storeModel);
		}
		return this.defaultEmbedder;
	}

	private inSection(filePath: string, section: string | undefined): boolean {
		if (!section) return true;
		return filePath === section || filePath.startsWith(`${section}/`);
	}

	/**
	 * Hybrid semantic search. Embeds the query on-device, ranks Smart Connections'
	 * stored block vectors by cosine similarity, and returns the top-k block-level
	 * hits scoped to `section` (falling back to the bridge's owning section, then
	 * the whole vault). Falls back to source-level entries only when no blocks
	 * exist in scope.
	 */
	async searchNotes(query: string, opts?: { section?: string; k?: number }): Promise<NoteHit[]> {
		const trimmed = query.trim();
		if (trimmed.length === 0) throw new Error("search_notes requires a non-empty query");
		const k = opts?.k && opts.k > 0 ? Math.floor(opts.k) : DEFAULT_TOP_K;
		const scope = normalizeSection(opts?.section) ?? this.section;
		const store = this.store();
		const scoped = Array.from(store.entries.values()).filter(e => this.inSection(e.filePath, scope));
		const blocks = scoped.filter(e => e.kind === "block");
		const pool = blocks.length > 0 ? blocks : scoped;
		if (pool.length === 0) return [];
		const queryVec = await this.embedderFor(store).embed(trimmed);
		const ranked = pool
			.map(entry => ({ entry, score: cosineSimilarity(queryVec, entry.vec) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
		return ranked.map(({ entry, score }) => this.toHit(entry, score));
	}

	private toHit(entry: EmbeddingEntry, score: number): NoteHit {
		const hit: NoteHit = {
			key: entry.key,
			file: entry.filePath,
			score,
			text: this.extractText(entry),
			granularity: entry.kind,
		};
		if (entry.subKey) hit.heading = entry.subKey.replace(/^#+/, "").replace(/#/g, " › ").trim();
		if (entry.lines) hit.lines = entry.lines;
		return hit;
	}

	/** Extract the text for a hit: block line-range if known, else heading section. */
	private extractText(entry: EmbeddingEntry): string {
		let content: string;
		try {
			content = fs.readFileSync(path.join(this.vaultRoot, entry.filePath), "utf8");
		} catch {
			return "";
		}
		const lines = content.split("\n");
		if (entry.lines) {
			const [start, end] = entry.lines;
			return lines
				.slice(Math.max(0, start - 1), end)
				.join("\n")
				.slice(0, MAX_HIT_CHARS)
				.trim();
		}
		if (entry.kind === "block" && entry.subKey)
			return this.extractHeadingSection(lines, entry.subKey).slice(0, MAX_HIT_CHARS);
		return content.slice(0, MAX_HIT_CHARS).trim();
	}

	/** Slice the section under the final heading of a `#a#b#c` breadcrumb. */
	private extractHeadingSection(lines: string[], subKey: string): string {
		const parts = subKey.split("#").filter(p => p.length > 0);
		const leaf = parts[parts.length - 1]?.trim().toLowerCase();
		if (!leaf) return lines.join("\n").trim();
		let start = -1;
		for (let i = 0; i < lines.length; i++) {
			const m = /^#{1,6}\s+(.*)$/.exec(lines[i]);
			if (m && m[1].trim().toLowerCase() === leaf) {
				start = i;
				break;
			}
		}
		if (start < 0) return "";
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) {
			if (/^#{1,6}\s+/.test(lines[i])) {
				end = i;
				break;
			}
		}
		return lines.slice(start, end).join("\n").trim();
	}

	/**
	 * Read a note's markdown content. Bare relative paths are rooted in the owning
	 * section (symmetric with {@link writeNote}); a known section prefix or an
	 * absolute path addresses the vault directly. Confined to the vault root.
	 */
	getNote(notePath: string): { path: string; content: string } {
		const { abs, rel } = this.resolveInVault(notePath, { rootInSection: true });
		const content = fs.readFileSync(abs, "utf8");
		return { path: rel, content };
	}

	/**
	 * Plain-file write of markdown into the vault. A relative path that does not
	 * already name a top-level section is rooted at the bridge's owning section,
	 * so an entity's writes land in its own area (SPEC §12.4 acceptance).
	 */
	writeNote(notePath: string, content: string): { path: string; bytesWritten: number; created: boolean } {
		const { abs, rel } = this.resolveInVault(notePath, { rootInSection: true });
		if (!rel.endsWith(".md")) throw new Error(`write_note only writes markdown (.md): ${rel}`);
		const created = !fs.existsSync(abs);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content, "utf8");
		this.invalidate();
		return { path: rel, bytesWritten: Buffer.byteLength(content, "utf8"), created };
	}

	/**
	 * Traverse the link graph from a note: forward wikilinks, backlinks, and the
	 * note's nearest vector neighbors (the "embed → entry node → traverse" hybrid,
	 * seeded from the note's own stored embedding — no query, no network).
	 */
	getConnections(notePath: string): Connections {
		const { abs, rel } = this.resolveInVault(notePath, { rootInSection: true });
		if (!fs.existsSync(abs)) throw new Error(`Note not found: ${rel}`);
		const graph = this.graph();
		return {
			file: rel,
			linksOut: graph
				.linksOut(rel)
				.map(l =>
					l.heading
						? { target: l.target, resolved: l.resolved, heading: l.heading }
						: { target: l.target, resolved: l.resolved },
				),
			linksIn: graph.linksIn(rel),
			relatedByVector: this.vectorNeighbors(rel),
		};
	}

	/** Nearest OTHER notes by the entry note's stored source embedding. */
	private vectorNeighbors(notePath: string, k: number = DEFAULT_RELATED): { file: string; score: number }[] {
		const store = this.store();
		const seed = store.entries.get(notePath);
		if (!seed) return [];
		const scores = new Map<string, number>();
		for (const entry of store.entries.values()) {
			if (entry.filePath === notePath) continue;
			const score = cosineSimilarity(seed.vec, entry.vec);
			const prev = scores.get(entry.filePath);
			if (prev === undefined || score > prev) scores.set(entry.filePath, score);
		}
		return Array.from(scores, ([file, score]) => ({ file, score }))
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
	}
}
