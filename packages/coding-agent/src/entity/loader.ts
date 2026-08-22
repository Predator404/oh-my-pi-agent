/**
 * Entity registry loader/resolver — contract C1.
 *
 * Loads persistent-entity records from the repo-2 registry (a directory of
 * Markdown records with YAML frontmatter) and resolves one into a launchable
 * session config for WS1's resident-worker launch. The registry layout is pure
 * data: adding an entity is a new record file, no code change (SPEC §12.2).
 *
 * On-demand prompt discipline (SPEC §5): `discoverEntities()` scans frontmatter
 * only and returns metadata with no system-prompt body; the full prompt is
 * loaded only when `loadEntityRecord()` / `resolveEntityConfig()` is called at
 * launch time — the worker is the lazy-load site.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isRecord, logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig } from "../advisor/config";
import { parseArrayOrCSV, parseBoolean, parseModelList } from "../discovery/helpers";
import { isValidThemeColor, type ThemeColor } from "../modes/theme/schema";
import type { AgentSource } from "../task/types";
import { parseConfiguredThinkingLevel } from "../thinking";
import { normalizeToolNames } from "../tools/builtin-names";
import {
	ENTITY_MEMORY_BACKENDS,
	type EntityHosting,
	type EntityMemory,
	type EntityMemoryBackend,
	type EntityRecord,
	type EntityRecordMeta,
	type EntityRole,
	type EntityWatchdog,
	type ResolvedEntityConfig,
} from "./schema";

/** Directory under the registry root holding one Markdown record per entity. */
export const ENTITY_RECORDS_SUBDIR = "entities";

/** Environment variable that overrides the default entity-registry root. */
export const ENTITY_REGISTRY_ENV = "OMP_ENTITY_REGISTRY";

/**
 * Filesystem-/id-safe entity name. Enforced at load so WS1 can hash the name
 * into session-lease and scheduled-job artifact paths without escaping.
 */
export const ENTITY_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const VALID_ROLES: readonly EntityRole[] = ["agent", "persona"];

/** A schema or policy violation in an entity record. */
export class EntityValidationError extends Error {
	constructor(
		message: string,
		readonly filePath?: string,
	) {
		super(filePath ? `${message} (${filePath})` : message);
		this.name = "EntityValidationError";
	}
}

/** No record exists for the requested entity name. */
export class EntityNotFoundError extends Error {
	constructor(
		readonly entityName: string,
		readonly filePath: string,
	) {
		super(`No entity record for "${entityName}" (looked in ${filePath})`);
		this.name = "EntityNotFoundError";
	}
}

/** Options shared by the registry entry points. */
export interface EntityRegistryOptions {
	/** Explicit registry root; overrides the env var and the default location. */
	registryRoot?: string;
}

/**
 * Resolve the entity-registry root: explicit option, else the
 * `OMP_ENTITY_REGISTRY` env var, else `<agentDir>/registry`. WS7 setup wires
 * the default location to the repo-2 checkout (symlink or env var).
 */
export function getEntityRegistryRoot(options: EntityRegistryOptions = {}): string {
	if (options.registryRoot?.trim()) {
		return path.resolve(options.registryRoot.trim());
	}
	const env = process.env[ENTITY_REGISTRY_ENV];
	if (env?.trim()) {
		return path.resolve(env.trim());
	}
	return path.join(getAgentDir(), "registry");
}

function requiredString(value: unknown, field: string, filePath: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new EntityValidationError(`Entity field "${field}" must be a non-empty string`, filePath);
	}
	return value.trim();
}

function parseRole(value: unknown, filePath: string): EntityRole {
	if (typeof value !== "string" || !VALID_ROLES.includes(value as EntityRole)) {
		throw new EntityValidationError(
			`Entity field "role" must be one of ${VALID_ROLES.map(r => `"${r}"`).join(" | ")}`,
			filePath,
		);
	}
	return value as EntityRole;
}

function parseMemory(value: unknown, role: EntityRole, filePath: string): EntityMemory {
	if (!isRecord(value)) {
		throw new EntityValidationError(
			`Entity field "memory" must be an object { backend, bank, autoRetain? }`,
			filePath,
		);
	}
	const backend = value.backend;
	if (typeof backend !== "string" || !ENTITY_MEMORY_BACKENDS.includes(backend as EntityMemoryBackend)) {
		throw new EntityValidationError(
			`Entity field "memory.backend" must be one of ${ENTITY_MEMORY_BACKENDS.map(b => `"${b}"`).join(" | ")}`,
			filePath,
		);
	}
	const bank = requiredString(value.bank, "memory.bank", filePath);
	let autoRetain = false;
	if (value.autoRetain !== undefined) {
		const parsed = parseBoolean(value.autoRetain);
		if (parsed === undefined) {
			throw new EntityValidationError(`Entity field "memory.autoRetain" must be a boolean`, filePath);
		}
		autoRetain = parsed;
	}
	// Retention policy (C1): only `agent` may auto-retain episodic turns; a
	// `persona` is curated-only. Reject the illegal combination outright rather
	// than silently coercing it to false — the record is wrong and must be fixed.
	if (role === "persona" && autoRetain) {
		throw new EntityValidationError(
			`role "persona" cannot set memory.autoRetain: true — personas are curated-only (set role: agent for episodic retention)`,
			filePath,
		);
	}
	return { backend: backend as EntityMemoryBackend, bank, autoRetain };
}

function parseWatchdog(value: unknown, filePath: string): EntityWatchdog | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) {
		throw new EntityValidationError(`Entity field "watchdog" must be a WATCHDOG.yml advisor entry object`, filePath);
	}
	const name = requiredString(value.name, "watchdog.name", filePath);
	const watchdog: AdvisorConfig = { name };
	if (value.model !== undefined) {
		if (typeof value.model !== "string") {
			throw new EntityValidationError(`Entity field "watchdog.model" must be a string`, filePath);
		}
		watchdog.model = value.model;
	}
	const tools = parseArrayOrCSV(value.tools);
	if (tools) watchdog.tools = normalizeToolNames(tools);
	if (value.instructions !== undefined) {
		if (typeof value.instructions !== "string") {
			throw new EntityValidationError(`Entity field "watchdog.instructions" must be a string`, filePath);
		}
		watchdog.instructions = value.instructions;
	}
	if (value.enabled !== undefined) {
		const enabled = parseBoolean(value.enabled);
		if (enabled === undefined) {
			throw new EntityValidationError(`Entity field "watchdog.enabled" must be a boolean`, filePath);
		}
		watchdog.enabled = enabled;
	}
	return watchdog;
}

function parseHosting(value: unknown, filePath: string): EntityHosting | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) {
		throw new EntityValidationError(`Entity field "hosting" must be an object { modelEndpoint? }`, filePath);
	}
	const hosting: EntityHosting = {};
	if (value.modelEndpoint !== undefined) {
		if (typeof value.modelEndpoint !== "string" || !value.modelEndpoint.trim()) {
			throw new EntityValidationError(`Entity field "hosting.modelEndpoint" must be a non-empty string`, filePath);
		}
		hosting.modelEndpoint = value.modelEndpoint.trim();
	}
	return hosting;
}

/** Grapheme segmenter for validating an `icon` is exactly one display glyph. */
const ICON_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function parseIcon(value: unknown, filePath: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new EntityValidationError(`Entity field "icon" must be a string`, filePath);
	}
	const icon = value.trim();
	if (!icon) return undefined;
	if (/\s/.test(icon)) {
		throw new EntityValidationError(`Entity field "icon" must not contain whitespace`, filePath);
	}
	const graphemes = [...ICON_GRAPHEME_SEGMENTER.segment(icon)];
	if (graphemes.length !== 1) {
		throw new EntityValidationError(
			`Entity field "icon" must be a single display glyph; got ${graphemes.length} in "${icon}"`,
			filePath,
		);
	}
	return icon;
}

function parseColor(value: unknown, filePath: string): ThemeColor | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new EntityValidationError(`Entity field "color" must be a string`, filePath);
	}
	const color = value.trim();
	if (!color) return undefined;
	if (!isValidThemeColor(color)) {
		throw new EntityValidationError(
			`Entity field "color" must be a theme-color token (e.g. accent, success, warning, error); got "${color}"`,
			filePath,
		);
	}
	return color;
}

/**
 * Validate + normalize entity-record frontmatter into {@link EntityRecordMeta}.
 * Throws {@link EntityValidationError} on any schema or retention-policy
 * violation. This is the authoritative C1 validator; it never coerces an
 * illegal record into a valid one.
 */
export function parseEntityMeta(
	frontmatter: Record<string, unknown>,
	filePath: string,
	source: AgentSource,
): EntityRecordMeta {
	const name = requiredString(frontmatter.name, "name", filePath);
	if (!ENTITY_NAME_PATTERN.test(name)) {
		throw new EntityValidationError(
			`Entity "name" must match ${ENTITY_NAME_PATTERN} (lowercase, no "/"); got "${name}"`,
			filePath,
		);
	}
	const description = requiredString(frontmatter.description, "description", filePath);
	const role = parseRole(frontmatter.role, filePath);
	const memory = parseMemory(frontmatter.memory, role, filePath);
	const vaultSection = requiredString(frontmatter.vaultSection, "vaultSection", filePath);

	let tools = parseArrayOrCSV(frontmatter.tools);
	if (tools) tools = normalizeToolNames(tools);
	const model = parseModelList(frontmatter.model);
	const thinkingLevel = parseConfiguredThinkingLevel(
		typeof frontmatter.thinkingLevel === "string"
			? frontmatter.thinkingLevel
			: typeof frontmatter.thinking === "string"
				? frontmatter.thinking
				: undefined,
	);
	const autoloadSkills = parseArrayOrCSV(frontmatter.autoloadSkills)
		?.map(s => s.trim())
		.filter(Boolean);

	return {
		name,
		description,
		role,
		icon: parseIcon(frontmatter.icon, filePath),
		color: parseColor(frontmatter.color, filePath),
		model,
		thinkingLevel,
		tools,
		autoloadSkills,
		memory,
		vaultSection,
		watchdog: parseWatchdog(frontmatter.watchdog, filePath),
		hosting: parseHosting(frontmatter.hosting, filePath),
		source,
		filePath,
	};
}

/**
 * Parse a full entity record (metadata + on-demand system-prompt body) from raw
 * record content. Throws {@link EntityValidationError} on malformed frontmatter
 * or any schema/policy violation.
 */
export function parseEntityRecord(filePath: string, content: string, source: AgentSource): EntityRecord {
	const { frontmatter, body } = parseFrontmatter(content, { location: filePath, level: "fatal" });
	const meta = parseEntityMeta(frontmatter, filePath, source);
	const systemPrompt = body.trim();
	if (!systemPrompt) {
		throw new EntityValidationError(`Entity record has an empty system prompt body`, filePath);
	}
	return { ...meta, systemPrompt };
}

/**
 * Load a single entity record by name (full read, including the system-prompt
 * body). This is the on-demand load site. Throws {@link EntityNotFoundError}
 * when no record exists and {@link EntityValidationError} on an invalid record.
 */
export async function loadEntityRecord(name: string, options: EntityRegistryOptions = {}): Promise<EntityRecord> {
	if (!ENTITY_NAME_PATTERN.test(name)) {
		throw new EntityValidationError(`Illegal entity name "${name}" — must match ${ENTITY_NAME_PATTERN}`);
	}
	const root = getEntityRegistryRoot(options);
	const filePath = path.join(root, ENTITY_RECORDS_SUBDIR, `${name}.md`);
	let content: string;
	try {
		content = await fs.readFile(filePath, "utf-8");
	} catch {
		throw new EntityNotFoundError(name, filePath);
	}
	const record = parseEntityRecord(filePath, content, "user");
	if (record.name !== name) {
		throw new EntityValidationError(
			`Entity record name "${record.name}" does not match its filename "${name}.md"`,
			filePath,
		);
	}
	return record;
}

/** One malformed record surfaced by {@link discoverEntities} (roster survives it). */
export interface EntityLoadError {
	filePath: string;
	error: string;
}

/** Roster-scan result: valid entity metadata plus surfaced load errors. */
export interface EntityDiscoveryResult {
	entities: EntityRecordMeta[];
	errors: EntityLoadError[];
}

/**
 * Discover all entity records in the registry (roster scan). Parses frontmatter
 * only — the system-prompt body is NOT loaded (SPEC §5 on-demand discipline).
 * Malformed or policy-violating records are surfaced in `errors` rather than
 * crashing the whole roster; duplicate names keep the first record and report
 * the rest.
 */
export async function discoverEntities(options: EntityRegistryOptions = {}): Promise<EntityDiscoveryResult> {
	const root = getEntityRegistryRoot(options);
	const dir = path.join(root, ENTITY_RECORDS_SUBDIR);
	const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = dirents
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.map(entry => entry.name)
		.sort((a, b) => a.localeCompare(b));

	const entities: EntityRecordMeta[] = [];
	const errors: EntityLoadError[] = [];
	const seen = new Set<string>();

	for (const fileName of files) {
		const filePath = path.join(dir, fileName);
		const expectedName = fileName.slice(0, -3);
		try {
			const content = await fs.readFile(filePath, "utf-8");
			// Frontmatter only — drop the body so no prompt is eagerly held.
			const { frontmatter } = parseFrontmatter(content, { location: filePath, level: "fatal" });
			const meta = parseEntityMeta(frontmatter, filePath, "user");
			if (meta.name !== expectedName) {
				throw new EntityValidationError(
					`Entity record name "${meta.name}" does not match its filename "${expectedName}.md"`,
					filePath,
				);
			}
			if (seen.has(meta.name)) {
				throw new EntityValidationError(`Duplicate entity name "${meta.name}"`, filePath);
			}
			seen.add(meta.name);
			entities.push(meta);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("Failed to load entity record", { filePath, error: message });
			errors.push({ filePath, error: message });
		}
	}

	return { entities, errors };
}

/** Options for {@link resolveEntityConfig}. */
export interface ResolveEntityOptions extends EntityRegistryOptions {
	/**
	 * Working directory the launch context binds the session to. Passed through
	 * onto {@link ResolvedEntityConfig.cwd}; when absent WS1's worker defaults to
	 * a per-entity home.
	 */
	cwd?: string;
}

/**
 * Resolve an entity record into a launchable session config (contract C1 →
 * WS1). This is the WS2→WS1 seam and the on-demand prompt-load site: it reads
 * the record body, validates + enforces the retention policy, and returns a
 * config WS1's worker maps onto OMP's `CreateAgentSessionOptions`.
 */
export async function resolveEntityConfig(
	name: string,
	options: ResolveEntityOptions = {},
): Promise<ResolvedEntityConfig> {
	const record = await loadEntityRecord(name, { registryRoot: options.registryRoot });
	return {
		name: record.name,
		description: record.description,
		role: record.role,
		icon: record.icon,
		color: record.color,
		model: record.model,
		thinkingLevel: record.thinkingLevel,
		systemPrompt: record.systemPrompt,
		tools: record.tools,
		autoloadSkills: record.autoloadSkills,
		memory: record.memory,
		vaultSection: record.vaultSection,
		watchdog: record.watchdog,
		hosting: record.hosting,
		cwd: options.cwd,
		source: { filePath: record.filePath },
	};
}
