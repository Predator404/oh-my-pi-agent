/**
 * Obsidian link graph for the vault MCP bridge (SPEC §7.1 graph path).
 *
 * `get_connections` walks the wikilink/backlink graph: forward links parsed out
 * of a note's body plus the reverse index of every other note that links to it.
 * This realizes the "entry node → traverse" half of the hybrid retrieval model;
 * the vector half is Smart Connections (see store.ts / vault.ts).
 *
 * Link syntax handled:
 *   - Wikilinks:  `[[Target]]`, `[[Target|alias]]`, `[[Target#Heading]]`,
 *     `[[folder/Target]]`, `[[Target^blockid]]`.
 *   - Markdown links to vault notes: `[text](Target.md)`, `[text](folder/T.md)`.
 * Embeds (`![[…]]`) are treated as links too (they create a graph edge).
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** A resolved forward link from one note to another. */
export interface ForwardLink {
	/** Raw link target text as written (may include folder, before `#`/`|`). */
	target: string;
	/** Vault-relative path the target resolved to, or undefined if unresolved. */
	resolved?: string;
	/** Heading fragment after `#`, if any. */
	heading?: string;
}

/** A note that links back to the entry note. */
export interface Backlink {
	/** Vault-relative path of the linking note. */
	source: string;
}

// [[wikilink]] or ![[embed]] — capture the inside up to the closing ]].
const WIKILINK_RE = /!?\[\[([^\]]+)\]\]/g;
// [text](target) markdown links — capture the target.
const MDLINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

/** Strip a wikilink inner to its note target (drop `#heading`, `|alias`, `^block`). */
function parseWikiTarget(inner: string): { target: string; heading?: string } {
	const noAlias = inner.split("|", 1)[0].trim();
	const caretIdx = noAlias.indexOf("^");
	const beforeBlock = caretIdx >= 0 ? noAlias.slice(0, caretIdx) : noAlias;
	const hashIdx = beforeBlock.indexOf("#");
	if (hashIdx >= 0) {
		return { target: beforeBlock.slice(0, hashIdx).trim(), heading: beforeBlock.slice(hashIdx + 1).trim() };
	}
	return { target: beforeBlock.trim() };
}

/** The vault link graph: forward links + reverse (backlink) index. */
export class VaultGraph {
	private readonly vaultRoot: string;
	/** note (vault-relative) → its forward links. */
	private readonly forward = new Map<string, ForwardLink[]>();
	/** target note (vault-relative) → notes that link to it. */
	private readonly reverse = new Map<string, Set<string>>();
	/** basename (lower, no ext) → vault-relative paths, for Obsidian-style resolution. */
	private readonly byBasename = new Map<string, string[]>();
	/** every known note path (vault-relative). */
	private readonly notes: string[] = [];

	constructor(vaultRoot: string) {
		this.vaultRoot = vaultRoot;
	}

	/** Build the graph by scanning every `.md` note under the vault root. */
	build(): this {
		this.forward.clear();
		this.reverse.clear();
		this.byBasename.clear();
		this.notes.length = 0;
		for (const rel of this.walkMarkdown(this.vaultRoot, "")) {
			this.notes.push(rel);
			const base = path.basename(rel, ".md").toLowerCase();
			const list = this.byBasename.get(base);
			if (list) list.push(rel);
			else this.byBasename.set(base, [rel]);
		}
		for (const rel of this.notes) {
			const body = fs.readFileSync(path.join(this.vaultRoot, rel), "utf8");
			this.forward.set(rel, this.extractLinks(body, rel));
		}
		for (const [source, links] of this.forward) {
			for (const link of links) {
				if (!link.resolved) continue;
				const backset = this.reverse.get(link.resolved);
				if (backset) backset.add(source);
				else this.reverse.set(link.resolved, new Set([source]));
			}
		}
		return this;
	}

	private *walkMarkdown(dir: string, prefix: string): Generator<string> {
		let dirents: fs.Dirent[];
		try {
			dirents = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of dirents) {
			if (ent.name.startsWith(".")) continue; // skip .smart-env, .git, etc.
			const rel = prefix.length > 0 ? `${prefix}/${ent.name}` : ent.name;
			if (ent.isDirectory()) {
				yield* this.walkMarkdown(path.join(dir, ent.name), rel);
			} else if (ent.isFile() && ent.name.endsWith(".md")) {
				yield rel;
			}
		}
	}

	private extractLinks(body: string, sourceRel: string): ForwardLink[] {
		const sourceDir = path.dirname(sourceRel);
		const links: ForwardLink[] = [];
		for (const match of body.matchAll(WIKILINK_RE)) {
			const { target, heading } = parseWikiTarget(match[1]);
			if (target.length === 0) continue;
			const resolved = this.resolveTarget(target, sourceDir);
			links.push(heading ? { target, resolved, heading } : { target, resolved });
		}
		for (const match of body.matchAll(MDLINK_RE)) {
			const rawTarget = match[1].trim();
			if (rawTarget.length === 0 || /^[a-z]+:\/\//i.test(rawTarget)) continue; // skip URLs
			const decoded = decodeURIComponent(rawTarget.split("#", 1)[0]);
			if (!decoded.endsWith(".md")) continue;
			const resolved = this.resolveTarget(decoded, sourceDir);
			links.push({ target: rawTarget, resolved });
		}
		return links;
	}

	/**
	 * Resolve a link target to a vault-relative note path (Obsidian semantics):
	 * exact path first, then a same-folder match, then a UNIQUE basename across
	 * the vault. Genuine basename ambiguity (2+ candidates, none same-folder)
	 * is left unresolved rather than guessing.
	 */
	private resolveTarget(target: string, sourceDir: string): string | undefined {
		const withExt = target.endsWith(".md") ? target : `${target}.md`;
		if (this.notes.includes(withExt)) return withExt;
		const base = path.basename(target, ".md");
		const sameFolder = sourceDir === "." ? `${base}.md` : `${sourceDir}/${base}.md`;
		if (this.notes.includes(sameFolder)) return sameFolder;
		const candidates = this.byBasename.get(base.toLowerCase());
		if (candidates && candidates.length === 1) return candidates[0];
		return undefined;
	}

	/** Forward links declared by a note. */
	linksOut(notePath: string): ForwardLink[] {
		return this.forward.get(notePath) ?? [];
	}

	/** Notes that link to a note. */
	linksIn(notePath: string): Backlink[] {
		const set = this.reverse.get(notePath);
		if (!set) return [];
		return Array.from(set, source => ({ source }));
	}

	/** Whether a note path is known to the graph. */
	has(notePath: string): boolean {
		return this.forward.has(notePath);
	}
}
