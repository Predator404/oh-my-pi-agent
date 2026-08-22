/**
 * `@@`-mention entity autocomplete: typing `@@` opens a picker over a
 * host-supplied roster of named entities (e.g. OMA's persona/agent registry).
 * Selecting an entry inserts `@@<name>: ` so the message reads as a direct
 * address. This module owns detection, fuzzy ranking, and applying any `@@`+
 * completion; it knows nothing about where candidates come from — the host
 * supplies them via {@link EntityMentionCandidateSource}.
 *
 * The `@`-count decides the mode (all resolved against the whitespace-anchored
 * `@`-run before the cursor):
 *   - `@`   (one)   -> file-mention picker (the base provider's behavior; this
 *                      module does not intercept it).
 *   - `@@`  (two)   -> entity picker (this module).
 *   - `@@@` (three+) -> escape hatch: the file picker again, with a single `@`
 *                      populated, so a user who wanted a file after opening the
 *                      entity picker gets a normal `@path` mention.
 */
import type { AutocompleteItem } from "../index";

/** Minimal display shape for an entity-mention candidate. */
export interface EntityMentionCandidate {
	name: string;
	description: string;
	role: string;
	icon?: string;
}

/** Supplies the full entity roster; this module fuzzy-filters against the query itself. */
export type EntityMentionCandidateSource = () => Promise<ReadonlyArray<EntityMentionCandidate>>;

/** A whitespace-anchored `@`-run token ending at the cursor. */
export interface EntityMention {
	/** The full token exactly as typed, e.g. `@@sec` or `@@@src/f`. */
	token: string;
	/** Number of leading `@` characters. */
	atCount: number;
	/** Text after the leading `@` run — the fuzzy query. */
	query: string;
}

const MAX_ENTITY_SUGGESTIONS = 12;

/** Higher is better: exact > prefix > substring > scattered subsequence. */
function fuzzyScore(query: string, target: string): number {
	if (query.length === 0) return 1;
	if (target === query) return 100;
	if (target.startsWith(query)) return 80;
	if (target.includes(query)) return 60;
	let qi = 0;
	let gaps = 0;
	let lastMatch = -1;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) {
			if (lastMatch >= 0 && ti - lastMatch > 1) gaps++;
			lastMatch = ti;
			qi++;
		}
	}
	if (qi !== query.length) return 0;
	return Math.max(1, 40 - gaps * 5);
}

/** Score an entity against the query, preferring name matches over description matches. */
function scoreEntity(query: string, entity: EntityMentionCandidate): number {
	if (query.length === 0) return 1;
	const nameScore = fuzzyScore(query, entity.name.toLowerCase());
	if (nameScore > 0) return nameScore;
	// Description-only hits rank strictly below any name hit (name scores are >= 1
	// only via the branch above; cap description hits under the subsequence floor).
	const descScore = fuzzyScore(query, entity.description.toLowerCase());
	return descScore > 0 ? Math.min(descScore, 39) : 0;
}

const MENTION_RE = /(?:^|\s)(@+)(\S*)$/;

/**
 * Extract the `@`-anchored mention token ending at the cursor. Returns null
 * unless the run starts at line start or immediately after whitespace, mirroring
 * the file-mention boundary rule the TUI editor and base provider enforce.
 */
export function extractEntityMention(textBeforeCursor: string): EntityMention | null {
	const match = MENTION_RE.exec(textBeforeCursor);
	if (!match) return null;
	const ats = match[1];
	const query = match[2];
	return { token: ats + query, atCount: ats.length, query };
}

/** Whether a completion `prefix` is an `@@`+ mention token (entity or escape-hatch). */
export function isEntityMentionPrefix(prefix: string): boolean {
	const mention = extractEntityMention(prefix);
	return mention !== null && mention.atCount >= 2;
}

/** Fuzzy entity suggestions for a `@@<query>` mention; empty when nothing matches. */
export async function getEntityMentionSuggestions(
	mention: EntityMention,
	source: EntityMentionCandidateSource | undefined,
): Promise<AutocompleteItem[]> {
	if (!source) return [];
	const entities = await source();
	if (entities.length === 0) return [];
	const query = mention.query.toLowerCase();
	return entities
		.map(entity => ({ entity, score: scoreEntity(query, entity) }))
		.filter(scored => scored.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_ENTITY_SUGGESTIONS)
		.map(({ entity }) => ({
			value: `@@${entity.name}: `,
			label: entity.name,
			description: entity.description ? `${entity.role} · ${entity.description}` : entity.role,
			icon: entity.icon,
		}));
}

/**
 * Apply a `@@`+ completion: replace the live `@`-run before the cursor with the
 * item's value. Re-anchoring to the live token (rather than the captured
 * `prefix`) keeps the edit correct when a debounced popup lags the buffer.
 * Works for both entity items (`@@<name>: `) and escape-hatch file items
 * (`@path`, which collapses the `@@@` run to a single-`@` mention).
 */
export function applyEntityMentionCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const currentLine = lines[cursorLine] || "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	const live = extractEntityMention(textBeforeCursor);
	const replaceLen = live ? live.token.length : prefix.length;
	const beforePrefix = currentLine.slice(0, cursorCol - replaceLen);
	const afterCursor = currentLine.slice(cursorCol);
	const newLines = [...lines];
	newLines[cursorLine] = beforePrefix + item.value + afterCursor;
	return { lines: newLines, cursorLine, cursorCol: beforePrefix.length + item.value.length };
}

/**
 * Collapse an `@@@`+ mention token to a single `@` in a working copy of the
 * buffer so the base provider sees a normal `@<query>` file mention. The cursor
 * shifts left by the dropped `@` count; the surrounding text is untouched.
 */
export function collapseMentionToSingleAt(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	mention: EntityMention,
): { lines: string[]; cursorCol: number } {
	const drop = mention.atCount - 1;
	const currentLine = lines[cursorLine] || "";
	const start = cursorCol - mention.token.length;
	const newLines = [...lines];
	newLines[cursorLine] = `${currentLine.slice(0, start)}@${mention.query}${currentLine.slice(cursorCol)}`;
	return { lines: newLines, cursorCol: cursorCol - drop };
}
