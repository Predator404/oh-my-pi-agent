/**
 * VaultBridge — the C3 vault operations behind the MCP server (SPEC §7, §12.4).
 *
 * A bridge holds an ACCESS SET: one writable HOME registry root (+ its owning
 * section, a C1 record's `vaultSection`, e.g. `agents/phi`) and zero or more
 * READ-ONLY registry roots, each tagged by registry id (ADR 0004). It exposes
 * the four C3 primitives:
 *   - {@link searchNotes}     text-grep search over vault markdown, scoped.
 *   - {@link getNote}         read a note's markdown.
 *   - {@link writeNote}       plain-file write into the correct section (home).
 *   - {@link getConnections}  wikilink/backlink traversal via regex scan.
 *
 * Embedding and vector search are delegated to mnemopi (BeamMemory.recall) when
 * available; the bridge's built-in fallback is a plain text-grep of markdown
 * files. Wikilink resolution uses a regex scan of `[[wikilink]]` syntax; the
 * vault:// protocol handler (Obsidian CLI) is the preferred path when available.
 * Reads target the home root by default; a `registry` id selects a read-only
 * root. Writes ALWAYS target home. Each root is confined by the same path-jail
 * (no `..` escape, no symlink break-out). Nothing here contacts the network.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A block-level search hit. */
export interface NoteHit {
	/** Store key: `<file>` or `<file>#<breadcrumb>`. */
	key: string;
	/** Vault-relative note path. */
	file: string;
	/** Heading breadcrumb for a block hit. */
	heading?: string;
	/** Relevance score (0..1). */
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
	/** Semantically-nearest OTHER notes (empty when embeddings unavailable). */
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
}

interface TextBlock {
	key: string;
	heading?: string;
	text: string;
	lines?: [number, number];
	granularity: "block" | "source";
}

interface LinkIndex {
	/** file → list of outgoing link targets (raw wikilink text). */
	forward: Map<string, { target: string; heading?: string }[]>;
	/** file → list of files that link TO it. */
	reverse: Map<string, string[]>;
	/** All .md file paths in the vault. */
	allFiles: string[];
}

export class VaultBridge {
	/** Home (writable) registry root — back-compat accessor. */
	readonly vaultRoot: string;
	/** Home owning section — back-compat accessor. */
	readonly section?: string;
	/** Home registry id. */
	readonly homeId: string;
	readonly #home: RootAccess;
	/** id → root: home first, then read-only roots in declared order. */
	readonly #roots: Map<string, RootAccess>;

	constructor(options: VaultBridgeOptions) {
		const section = normalizeSection(options.section);
		this.homeId = options.homeId ?? DEFAULT_HOME_REGISTRY_ID;
		this.section = section;
		this.#home = {
			id: this.homeId,
			root: canonicalRoot(options.vaultRoot),
			writable: true,
			section,
		};
		this.vaultRoot = this.#home.root;
		this.#roots = new Map([[this.#home.id, this.#home]]);
		for (const readable of options.readable ?? []) {
			if (this.#roots.has(readable.id)) continue;
			this.#roots.set(readable.id, {
				id: readable.id,
				root: canonicalRoot(readable.root),
				writable: false,
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

	/** Force a reload of cached state (no-op; kept for API compatibility). */
	invalidate(): void {
		// Caches (embedding store, link graph) are no longer held in-process.
	}

	#inSection(filePath: string, section: string | undefined): boolean {
		if (!section) return true;
		return filePath === section || filePath.startsWith(`${section}/`);
	}

	// ── searchNotes: text-grep fallback ───────────────────────────────────

	/**
	 * Text-grep search over vault markdown files. Walks `.md` files under the
	 * target root, splits each into heading-delimited blocks, and ranks blocks by
	 * how many query terms they contain. Returns block-level hits scoped to
	 * `section` (falling back to the root's owning section, then the whole root).
	 * Reads the home root unless `registry` selects another readable root.
	 *
	 * When a mnemopi {@link BeamMemory} is available, prefer its `recall()` for
	 * semantic (vector) search; this method is the offline fallback.
	 */
	searchNotes(query: string, opts?: { section?: string; k?: number; registry?: string }): NoteHit[] {
		const trimmed = query.trim();
		if (trimmed.length === 0) throw new Error("search_notes requires a non-empty query");
		const k = opts?.k && opts.k > 0 ? Math.floor(opts.k) : DEFAULT_TOP_K;
		const access = this.#access(opts?.registry);
		const scope = normalizeSection(opts?.section) ?? access.section;
		const queryTerms = trimmed
			.toLowerCase()
			.split(/\s+/)
			.filter(t => t.length > 0);
		const hits = this.#grepSearch(access.root, scope, queryTerms, k);
		return hits;
	}

	/** Walk .md files, split into blocks, rank by term match density. */
	#grepSearch(root: string, scope: string | undefined, terms: string[], k: number): NoteHit[] {
		const results: NoteHit[] = [];
		const mdFiles = this.#collectMdFiles(root, scope);
		for (const relPath of mdFiles) {
			let content: string;
			try {
				content = fs.readFileSync(path.join(root, relPath), "utf8");
			} catch {
				continue;
			}
			const blocks = this.#splitBlocks(content, relPath);
			for (const block of blocks) {
				const lower = block.text.toLowerCase();
				let matchCount = 0;
				for (const term of terms) {
					// Count non-overlapping occurrences
					let idx = 0;
					while ((idx = lower.indexOf(term, idx)) >= 0) {
						matchCount++;
						idx += term.length;
					}
				}
				if (matchCount === 0) continue;
				// Score: match density capped at 1.0
				const wordCount = Math.max(1, lower.split(/\s+/).length);
				const score = Math.min(1, (matchCount / Math.max(1, terms.length)) * ((matchCount / wordCount) * 10));
				results.push({
					key: block.key,
					file: relPath,
					heading: block.heading,
					score: Math.round(score * 1000) / 1000,
					lines: block.lines,
					text: block.text.slice(0, MAX_HIT_CHARS).trim(),
					granularity: block.granularity,
				});
			}
		}
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, k);
	}

	/** Collect all .md files under a root, optionally scoped to a section prefix. */
	#collectMdFiles(root: string, scope: string | undefined): string[] {
		const files: string[] = [];
		const scopePrefix = scope ? `${scope}/` : undefined;
		const walk = (dir: string, relDir: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const absChild = path.join(dir, entry.name);
				const relChild = relDir ? `${relDir}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					// Only recurse if within scope or no scope restriction
					if (
						!scopePrefix ||
						relChild === scope ||
						relChild.startsWith(scopePrefix) ||
						(scope !== undefined && scope.startsWith(relChild))
					) {
						walk(absChild, relChild);
					}
				} else if (entry.isFile() && entry.name.endsWith(".md")) {
					if (!scopePrefix || relChild === scope || relChild.startsWith(scopePrefix)) {
						files.push(relChild);
					}
				}
			}
		};
		walk(root, "");
		return files;
	}

	/** Split a markdown file into heading-delimited blocks. */
	#splitBlocks(content: string, relPath: string): TextBlock[] {
		const lines = content.split("\n");
		const blocks: TextBlock[] = [];
		const headings: { level: number; title: string; lineIdx: number }[] = [];

		for (let i = 0; i < lines.length; i++) {
			const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
			if (m) {
				headings.push({ level: m[1].length, title: m[2].trim(), lineIdx: i });
			}
		}

		if (headings.length === 0) {
			// Whole file as one source block
			const text = content.trim();
			if (text.length > 0) {
				blocks.push({
					key: relPath,
					text,
					lines: [1, lines.length],
					granularity: "source",
				});
			}
			return blocks;
		}

		// Preamble before first heading
		if (headings[0].lineIdx > 0) {
			const text = lines.slice(0, headings[0].lineIdx).join("\n").trim();
			if (text.length > 0) {
				blocks.push({
					key: relPath,
					text,
					lines: [1, headings[0].lineIdx],
					granularity: "source",
				});
			}
		}

		// Each heading section as a block
		for (let i = 0; i < headings.length; i++) {
			const h = headings[i];
			const startLine = h.lineIdx + 1; // 1-based
			const endLine = i + 1 < headings.length ? headings[i + 1].lineIdx : lines.length;
			const blockLines = lines.slice(h.lineIdx, endLine);
			const text = blockLines.join("\n").trim();
			if (text.length === 0) continue;
			const breadcrumb = headings
				.slice(0, i + 1)
				.map(x => x.title)
				.join("#");
			blocks.push({
				key: `${relPath}#${breadcrumb}`,
				heading: breadcrumb.replace(/#/g, " › "),
				text,
				lines: [startLine, endLine],
				granularity: "block",
			});
		}

		return blocks;
	}

	// ── getNote / writeNote (unchanged) ───────────────────────────────────

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

	// ── getConnections: wikilink regex scan ───────────────────────────────

	/**
	 * Traverse the link graph from a note: forward wikilinks and backlinks via
	 * regex scan of `[[wikilink]]` syntax across all vault markdown files.
	 * The `relatedByVector` field is always empty (embedding-based neighbors
	 * require mnemopi; use the vault:// protocol handler for Obsidian CLI graph).
	 * Reads the home root unless `registry` selects another readable root.
	 */
	getConnections(notePath: string, registry?: string): Connections {
		const access = this.#access(registry);
		const { abs, rel } = this.#resolveIn(access, notePath, { rootInSection: true });
		if (!fs.existsSync(abs)) throw new Error(`Note not found: ${rel}`);
		const index = this.#buildLinkIndex(access.root);
		return {
			file: rel,
			linksOut: this.#resolveLinksOut(rel, index),
			linksIn: this.#resolveLinksIn(rel, index),
			relatedByVector: [],
		};
	}

	/** Build a forward + reverse link index for all .md files under a root. */
	#buildLinkIndex(root: string): LinkIndex {
		const forward = new Map<string, { target: string; heading?: string }[]>();
		const reverse = new Map<string, string[]>();
		const allFiles = this.#collectMdFiles(root, undefined);

		// [[wikilink]] or ![[embed]]
		const wikilinkRe = /!?\[\[([^\]]+)\]\]/g;

		for (const relPath of allFiles) {
			let content: string;
			try {
				content = fs.readFileSync(path.join(root, relPath), "utf8");
			} catch {
				continue;
			}
			const links: { target: string; heading?: string }[] = [];
			for (const m of content.matchAll(wikilinkRe)) {
				const inner = m[1];
				const parsed = this.#parseWikiTarget(inner);
				links.push(parsed);
				// Build reverse index: target → source
				const normTarget = parsed.target.toLowerCase();
				const sources = reverse.get(normTarget) ?? [];
				if (!sources.includes(relPath)) {
					sources.push(relPath);
					reverse.set(normTarget, sources);
				}
			}
			forward.set(relPath, links);
		}

		return { forward, reverse, allFiles };
	}

	/** Parse a wikilink inner text to extract target note and optional heading. */
	#parseWikiTarget(inner: string): { target: string; heading?: string } {
		const noAlias = inner.split("|", 1)[0].trim();
		const caretIdx = noAlias.indexOf("^");
		const beforeBlock = caretIdx >= 0 ? noAlias.slice(0, caretIdx) : noAlias;
		const hashIdx = beforeBlock.indexOf("#");
		if (hashIdx >= 0) {
			return { target: beforeBlock.slice(0, hashIdx).trim(), heading: beforeBlock.slice(hashIdx + 1).trim() };
		}
		return { target: beforeBlock.trim() };
	}

	/** Resolve outgoing links for a note, preferring same-folder matches. */
	#resolveLinksOut(notePath: string, index: LinkIndex): { target: string; resolved?: string; heading?: string }[] {
		const links = index.forward.get(notePath) ?? [];
		const noteDir = path.dirname(notePath);
		const knownFiles = new Set(index.allFiles.map(f => f.toLowerCase()));
		const basenameIndex = new Map<string, string[]>(); // lowercase basename → full paths
		for (const f of index.allFiles) {
			const base = path.basename(f, ".md").toLowerCase();
			const list = basenameIndex.get(base) ?? [];
			list.push(f);
			basenameIndex.set(base, list);
		}

		return links.map(link => {
			// Try exact path match first
			const exactCandidates = [
				link.target,
				`${link.target}.md`,
				path.join(noteDir, link.target),
				path.join(noteDir, `${link.target}.md`),
			];
			for (const c of exactCandidates) {
				if (knownFiles.has(c.toLowerCase())) return { target: link.target, resolved: c, heading: link.heading };
			}

			// Try basename match
			const base = path.basename(link.target).toLowerCase();
			const matches = basenameIndex.get(base);
			if (matches && matches.length === 1) {
				return { target: link.target, resolved: matches[0], heading: link.heading };
			}
			// Same-folder preference for ambiguous basenames
			if (matches && matches.length > 1) {
				const sameFolder = matches.find(m => path.dirname(m) === noteDir);
				if (sameFolder) return { target: link.target, resolved: sameFolder, heading: link.heading };
			}

			return { target: link.target, heading: link.heading };
		});
	}

	/** Resolve incoming links (backlinks) for a note. */
	#resolveLinksIn(notePath: string, index: LinkIndex): { source: string }[] {
		const normPath = notePath.toLowerCase();
		// Direct match
		const direct = index.reverse.get(normPath) ?? [];
		// Basename match (notes linked as [[NoteName]] without path)
		const base = path.basename(notePath, ".md").toLowerCase();
		const basenameSources = index.reverse.get(base) ?? [];
		const sources = [...new Set([...direct, ...basenameSources])];
		return sources.map(s => ({ source: s }));
	}
}
