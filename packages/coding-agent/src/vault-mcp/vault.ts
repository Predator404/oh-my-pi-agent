/**
 * VaultBridge — the C3 vault operations behind the MCP server (SPEC §7, §12.4).
 *
 * A bridge holds an ACCESS SET: one writable HOME registry root (+ its owning
 * section, a C1 record's `vaultSection`, e.g. `agents/phi`) and zero or more
 * READ-ONLY registry roots, each tagged by registry id (ADR 0004). It exposes
 * the four C3 primitives:
 *   - {@link searchNotes}     hybrid semantic search → block-level hits, scoped.
 *   - {@link getNote}         read a note's markdown.
 *   - {@link writeNote}       plain-file write into the correct section (home).
 *   - {@link getConnections}  wikilink/backlink traversal (+ vector neighbors).
 *
 * Reads target the home root by default; a `registry` id selects a read-only
 * root. Writes ALWAYS target home. Each root is confined by the same path-jail
 * (no `..` escape, no symlink break-out) and has its own Smart Connections
 * store, loaded lazily. Nothing here contacts the network: semantic ranking
 * reads the local store and embeds the query with an on-device model.
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

/** A read-only registry root the bridge may read (never write). */
export interface ReadonlyRoot {
	/** Registry id selecting this root in read calls. */
	id: string;
	/** Absolute registry root. */
	root: string;
}

/** Options controlling {@link VaultBridge} construction. */
export interface VaultBridgeOptions {
	/** Absolute vault root of the writable HOME registry. */
	vaultRoot: string;
	/** Owning section (vault-relative), default scope for search/write on home. */
	section?: string;
	/** Injected embedder; defaults to on-device {@link TransformersEmbedder}. */
	embedder?: Embedder;
	/** Home registry id (default `oma`); the id read calls default to. */
	homeId?: string;
	/** Read-only registry roots (each tagged by id) the bridge may read. */
	readable?: readonly ReadonlyRoot[];
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

const DEFAULT_HOME_REGISTRY_ID = "oma";

/** One root in the bridge's access set: the writable home or a read-only registry. */
interface RootAccess {
	readonly id: string;
	/** Canonical (symlink-resolved) absolute root. */
	readonly root: string;
	readonly writable: boolean;
	/** Owning section (home only); read calls default their scope to it. */
	readonly section?: string;
	/** Lazily-loaded Smart Connections store for this root. */
	store: SmartConnectionsStore | null;
	/** Lazily-built link graph for this root. */
	graph: VaultGraph | null;
}

export class VaultBridge {
	/** Home (writable) registry root — back-compat accessor. */
	readonly vaultRoot: string;
	/** Home owning section — back-compat accessor. */
	readonly section?: string;
	/** Home registry id. */
	readonly homeId: string;
	readonly #injectedEmbedder?: Embedder;
	#defaultEmbedder: Embedder | null = null;
	readonly #home: RootAccess;
	/** id → root: home first, then read-only roots in declared order. */
	readonly #roots: Map<string, RootAccess>;

	constructor(options: VaultBridgeOptions) {
		const section = normalizeSection(options.section);
		this.homeId = options.homeId ?? DEFAULT_HOME_REGISTRY_ID;
		this.section = section;
		this.#injectedEmbedder = options.embedder;
		this.#home = {
			id: this.homeId,
			root: canonicalRoot(options.vaultRoot),
			writable: true,
			section,
			store: null,
			graph: null,
		};
		this.vaultRoot = this.#home.root;
		this.#roots = new Map([[this.#home.id, this.#home]]);
		for (const readable of options.readable ?? []) {
			if (this.#roots.has(readable.id)) continue;
			this.#roots.set(readable.id, {
				id: readable.id,
				root: canonicalRoot(readable.root),
				writable: false,
				store: null,
				graph: null,
			});
		}
	}

	/** Ids in the access set, home first (for discoverability). */
	registryIds(): string[] {
		return Array.from(this.#roots.keys());
	}

	/** Select the root a read targets; throws if the id is not in the access set. */
	#access(registry?: string): RootAccess {
		if (!registry || registry === this.homeId) return this.#home;
		const entry = this.#roots.get(registry);
		if (!entry) throw new Error(`Registry not accessible: ${registry}`);
		return entry;
	}

	/**
	 * Confine a caller-supplied path to one root. Relative paths that do not
	 * already name a top-level vault subtree are rooted at the root's owning
	 * section (home only, when `rootInSection`). Throws on escape.
	 */
	#resolveIn(access: RootAccess, relOrAbs: string, opts?: { rootInSection?: boolean }): { abs: string; rel: string } {
		const cleaned = relOrAbs.trim();
		if (cleaned.length === 0) throw new Error("Empty note path");
		const root = access.root;
		let candidate: string;
		if (path.isAbsolute(cleaned)) {
			candidate = path.resolve(cleaned);
		} else {
			const firstSeg = cleaned.split(/[/\\]/, 1)[0];
			const sectionRoot = access.section?.split("/", 1)[0];
			const namesSection =
				KNOWN_SECTION_ROOTS.includes(firstSeg) || (sectionRoot !== undefined && firstSeg === sectionRoot);
			const base = opts?.rootInSection && access.section && !namesSection ? path.join(root, access.section) : root;
			candidate = path.resolve(base, cleaned);
		}
		const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
		const real = this.#realExistingPrefix(candidate);
		if (real !== root && !real.startsWith(rootWithSep)) {
			throw new Error(`Path escapes vault root: ${relOrAbs}`);
		}
		if (candidate !== root && !candidate.startsWith(rootWithSep)) {
			throw new Error(`Path escapes vault root: ${relOrAbs}`);
		}
		return { abs: candidate, rel: path.relative(root, candidate) };
	}

	/** Confine a caller-supplied path to the HOME vault root (back-compat surface). */
	resolveInVault(relOrAbs: string, opts?: { rootInSection?: boolean }): { abs: string; rel: string } {
		return this.#resolveIn(this.#home, relOrAbs, opts);
	}

	/** realpath of the deepest existing ancestor (defends against symlink escape). */
	#realExistingPrefix(candidate: string): string {
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

	#store(access: RootAccess): SmartConnectionsStore {
		if (!access.store) access.store = loadSmartConnectionsStore(access.root);
		return access.store;
	}

	#graph(access: RootAccess): VaultGraph {
		if (!access.graph) access.graph = new VaultGraph(access.root).build();
		return access.graph;
	}

	/** Force a reload of the home embedding store + link graph (after writes). */
	invalidate(): void {
		this.#home.store = null;
		this.#home.graph = null;
	}

	/**
	 * Choose the query embedder so it matches the model that produced the store's
	 * vectors — ranking across mismatched models is meaningless (cosine over
	 * differently-dimensioned/differently-trained vectors). An injected embedder
	 * MUST match the store model (hard error otherwise); the default embedder is
	 * built lazily from the store's recorded model key.
	 */
	#embedderFor(store: SmartConnectionsStore): Embedder {
		const storeModel = store.model.modelKey;
		if (this.#injectedEmbedder) {
			if (this.#injectedEmbedder.modelKey !== storeModel) {
				throw new Error(
					`Query embedder model '${this.#injectedEmbedder.modelKey}' does not match the vault's stored embedding model '${storeModel}'; semantic rankings would be meaningless. Provide an embedder for '${storeModel}'.`,
				);
			}
			return this.#injectedEmbedder;
		}
		if (!this.#defaultEmbedder || this.#defaultEmbedder.modelKey !== storeModel) {
			this.#defaultEmbedder = new TransformersEmbedder(storeModel);
		}
		return this.#defaultEmbedder;
	}

	#inSection(filePath: string, section: string | undefined): boolean {
		if (!section) return true;
		return filePath === section || filePath.startsWith(`${section}/`);
	}

	/**
	 * Hybrid semantic search. Embeds the query on-device, ranks Smart Connections'
	 * stored block vectors by cosine similarity, and returns the top-k block-level
	 * hits scoped to `section` (falling back to the target root's owning section,
	 * then the whole root). Reads the home root unless `registry` selects another
	 * readable root (rejected if not in the access set). Falls back to
	 * source-level entries only when no blocks exist in scope.
	 */
	async searchNotes(query: string, opts?: { section?: string; k?: number; registry?: string }): Promise<NoteHit[]> {
		const trimmed = query.trim();
		if (trimmed.length === 0) throw new Error("search_notes requires a non-empty query");
		const k = opts?.k && opts.k > 0 ? Math.floor(opts.k) : DEFAULT_TOP_K;
		const access = this.#access(opts?.registry);
		const scope = normalizeSection(opts?.section) ?? access.section;
		const store = this.#store(access);
		const scoped = Array.from(store.entries.values()).filter(e => this.#inSection(e.filePath, scope));
		const blocks = scoped.filter(e => e.kind === "block");
		const pool = blocks.length > 0 ? blocks : scoped;
		if (pool.length === 0) return [];
		const queryVec = await this.#embedderFor(store).embed(trimmed);
		const ranked = pool
			.map(entry => ({ entry, score: cosineSimilarity(queryVec, entry.vec) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
		return ranked.map(({ entry, score }) => this.#toHit(access, entry, score));
	}

	#toHit(access: RootAccess, entry: EmbeddingEntry, score: number): NoteHit {
		const hit: NoteHit = {
			key: entry.key,
			file: entry.filePath,
			score,
			text: this.#extractText(access, entry),
			granularity: entry.kind,
		};
		if (entry.subKey) hit.heading = entry.subKey.replace(/^#+/, "").replace(/#/g, " › ").trim();
		if (entry.lines) hit.lines = entry.lines;
		return hit;
	}

	/** Extract the text for a hit: block line-range if known, else heading section. */
	#extractText(access: RootAccess, entry: EmbeddingEntry): string {
		let content: string;
		try {
			content = fs.readFileSync(path.join(access.root, entry.filePath), "utf8");
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
			return this.#extractHeadingSection(lines, entry.subKey).slice(0, MAX_HIT_CHARS);
		return content.slice(0, MAX_HIT_CHARS).trim();
	}

	/** Slice the section under the final heading of a `#a#b#c` breadcrumb. */
	#extractHeadingSection(lines: string[], subKey: string): string {
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
	 * absolute path addresses the root directly. Reads the home root unless
	 * `registry` selects another readable root. Confined to the target root.
	 */
	getNote(notePath: string, registry?: string): { path: string; content: string } {
		const access = this.#access(registry);
		const { abs, rel } = this.#resolveIn(access, notePath, { rootInSection: true });
		const content = fs.readFileSync(abs, "utf8");
		return { path: rel, content };
	}

	/**
	 * Plain-file write of markdown into the HOME vault (writes never target a
	 * read-only registry). A relative path that does not already name a top-level
	 * section is rooted at the home owning section, so an entity's writes land in
	 * its own area (SPEC §12.4 acceptance).
	 */
	writeNote(notePath: string, content: string): { path: string; bytesWritten: number; created: boolean } {
		const { abs, rel } = this.#resolveIn(this.#home, notePath, { rootInSection: true });
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
	 * seeded from the note's own stored embedding — no query, no network). Reads
	 * the home root unless `registry` selects another readable root.
	 */
	getConnections(notePath: string, registry?: string): Connections {
		const access = this.#access(registry);
		const { abs, rel } = this.#resolveIn(access, notePath, { rootInSection: true });
		if (!fs.existsSync(abs)) throw new Error(`Note not found: ${rel}`);
		const graph = this.#graph(access);
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
			relatedByVector: this.#vectorNeighbors(access, rel),
		};
	}

	/** Nearest OTHER notes by the entry note's stored source embedding. */
	#vectorNeighbors(
		access: RootAccess,
		notePath: string,
		k: number = DEFAULT_RELATED,
	): { file: string; score: number }[] {
		const store = this.#store(access);
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
