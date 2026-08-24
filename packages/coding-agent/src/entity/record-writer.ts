/**
 * WS7 — entity-record authoring (SPEC §12.7 acceptance: "entity config editable
 * without hand-editing files"). Creates and patches C1 registry records
 * (`<registryRoot>/entities/<name>.md`) through validated writes so the CLI can
 * drive the WS2 registry without a human touching YAML.
 *
 * Every write round-trips through {@link parseEntityRecord}: a create or patch
 * that would produce an invalid record (bad role, persona + autoRetain, empty
 * prompt, …) throws BEFORE anything hits disk. Reads/edits preserve the
 * Markdown body (the system prompt) verbatim — only frontmatter fields change.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	ENTITY_NAME_PATTERN,
	ENTITY_RECORDS_SUBDIR,
	type EntityRegistryOptions,
	EntityValidationError,
	enforceBankNamespace,
	parseEntityRecord,
} from "./loader";
import { DEFAULT_REGISTRY_ID, getRegistry, loadRegistryManifest, type RegistryVisibility } from "./registries";
import type { EntityRole } from "./schema";

/** Fields accepted when scaffolding a new entity record. */
export interface CreateEntityFields {
	role: EntityRole;
	description: string;
	/** Optional single display glyph marking this entity in the UI. */
	icon?: string;
	/** Optional theme-color token tinting this entity's label/marker. */
	color?: string;
	/** System-prompt body (identity/voice/remit). Required, non-empty. */
	systemPrompt: string;
	model?: string[];
	thinkingLevel?: string;
	tools?: string[];
	autoloadSkills?: string[];
	memory?: { backend?: string; bank?: string; autoRetain?: boolean };
	/** Owned vault subtree; defaults to `<agents|personas>/<name>`. */
	vaultSection?: string;
	hosting?: { modelEndpoint?: string };
}

/** Outcome of a create/patch write. */
export interface WriteEntityRecordResult {
	name: string;
	filePath: string;
	/** True when the file was newly created (false when an existing record was patched). */
	created: boolean;
}

/**
 * Where a write lands. Either an explicit single `registryRoot` (legacy) or a
 * `registry` id resolved against the manifest (ADR 0004). Manifest source is the
 * preloaded `manifest` when given, else the file at `manifestPath`/env/default.
 */
export type WriteRegistryOptions = EntityRegistryOptions & { registry?: string };

/** The registry a write targets: its id, resolved root, and read exposure. */
interface TargetRegistry {
	id: string;
	root: string;
	visibility: RegistryVisibility;
}

/**
 * Resolve the registry a record write targets. An explicit `registryRoot` pins a
 * single public root (legacy id {@link DEFAULT_REGISTRY_ID}); otherwise the
 * `registry` id (default {@link DEFAULT_REGISTRY_ID}) is looked up in the manifest.
 */
async function resolveTargetRegistry(options: WriteRegistryOptions): Promise<TargetRegistry> {
	if (options.registryRoot?.trim()) {
		return { id: DEFAULT_REGISTRY_ID, root: path.resolve(options.registryRoot.trim()), visibility: "public" };
	}
	const manifest = options.manifest ?? (await loadRegistryManifest({ manifestPath: options.manifestPath }));
	const entry = getRegistry(manifest, options.registry ?? DEFAULT_REGISTRY_ID);
	return { id: entry.id, root: entry.root, visibility: entry.visibility };
}

function recordPath(name: string, root: string): string {
	return path.join(root, ENTITY_RECORDS_SUBDIR, `${name}.md`);
}

/** Serialize frontmatter + prompt body into an entity-record Markdown file. */
export function serializeEntityRecord(frontmatter: Record<string, unknown>, body: string): string {
	const yaml = YAML.stringify(frontmatter, null, 2).replace(/\n+$/, "");
	return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

/**
 * Scaffold a new entity record. Validates the resulting record (including the
 * role→retention policy) before writing. Refuses to overwrite an existing
 * record unless `force` is set.
 */
export async function createEntityRecord(
	name: string,
	fields: CreateEntityFields,
	options: WriteRegistryOptions & { force?: boolean } = {},
): Promise<WriteEntityRecordResult> {
	if (!ENTITY_NAME_PATTERN.test(name)) {
		throw new EntityValidationError(`Illegal entity name "${name}" — must match ${ENTITY_NAME_PATTERN}`);
	}
	const registry = await resolveTargetRegistry(options);
	const filePath = recordPath(name, registry.root);
	const vaultSection = fields.vaultSection ?? `${fields.role === "agent" ? "agents" : "personas"}/${name}`;
	const frontmatter: Record<string, unknown> = {
		name,
		description: fields.description,
		role: fields.role,
	};
	if (fields.icon) frontmatter.icon = fields.icon;
	if (fields.color) frontmatter.color = fields.color;
	if (fields.model?.length) frontmatter.model = fields.model;
	if (fields.thinkingLevel) frontmatter.thinkingLevel = fields.thinkingLevel;
	if (fields.tools?.length) frontmatter.tools = fields.tools;
	if (fields.autoloadSkills?.length) frontmatter.autoloadSkills = fields.autoloadSkills;
	frontmatter.memory = {
		backend: fields.memory?.backend ?? "mnemopi",
		bank: fields.memory?.bank ?? name,
		autoRetain: fields.memory?.autoRetain ?? false,
	};
	frontmatter.vaultSection = vaultSection;
	if (fields.hosting?.modelEndpoint) frontmatter.hosting = { modelEndpoint: fields.hosting.modelEndpoint };

	const content = serializeEntityRecord(frontmatter, fields.systemPrompt);
	// Validate + enforce policy (schema, retention, declared-registry, bank namespace) before disk.
	const record = parseEntityRecord(filePath, content, "user", registry.id);
	enforceBankNamespace(record.memory.bank, registry.id, registry.visibility, filePath);

	// Distinguish a fresh create from a forced overwrite so `created` is honest.
	let existedBefore = false;
	try {
		await fs.stat(filePath);
		existedBefore = true;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (existedBefore && !options.force) {
		throw new EntityValidationError(
			`Entity "${name}" already exists at ${filePath} (use --force to overwrite)`,
			filePath,
		);
	}

	await fs.mkdir(path.dirname(filePath), { recursive: true });
	// `wx` still guards a create-time race when not forcing.
	await fs.writeFile(filePath, content, { encoding: "utf8", flag: options.force ? "w" : "wx" });
	return { name, filePath, created: !existedBefore };
}

/**
 * Apply a single `key=value` field update to a frontmatter object in place.
 * Supports the C1 field surface via dotted keys (`memory.bank`,
 * `hosting.modelEndpoint`, `watchdog.enabled`, …). List fields accept a
 * comma-separated value. Throws on an unknown key or a malformed value.
 */
export function applyEntityFieldUpdate(frontmatter: Record<string, unknown>, key: string, rawValue: string): void {
	const value = rawValue.trim();
	const asList = (): string[] =>
		value
			.split(",")
			.map(s => s.trim())
			.filter(Boolean);
	const asBool = (): boolean => {
		if (value === "true") return true;
		if (value === "false") return false;
		throw new EntityValidationError(`Field "${key}" must be "true" or "false", got "${value}"`);
	};
	const setNested = (parent: string, child: string, v: unknown): void => {
		const existing = isRecord(frontmatter[parent]) ? (frontmatter[parent] as Record<string, unknown>) : {};
		frontmatter[parent] = { ...existing, [child]: v };
	};

	switch (key) {
		case "description":
		case "role":
		case "thinkingLevel":
		case "vaultSection":
		case "icon":
		case "color":
			frontmatter[key] = value;
			return;
		case "thinking":
			frontmatter.thinkingLevel = value;
			return;
		case "model":
		case "tools":
		case "autoloadSkills":
			frontmatter[key] = asList();
			return;
		case "memory.bank":
			setNested("memory", "bank", value);
			return;
		case "memory.backend":
			setNested("memory", "backend", value);
			return;
		case "memory.autoRetain":
			setNested("memory", "autoRetain", asBool());
			return;
		case "hosting.modelEndpoint":
			setNested("hosting", "modelEndpoint", value);
			return;
		case "watchdog.name":
		case "watchdog.model":
		case "watchdog.instructions":
			setNested("watchdog", key.slice("watchdog.".length), value);
			return;
		case "watchdog.enabled":
			setNested("watchdog", "enabled", asBool());
			return;
		case "watchdog.tools":
			setNested("watchdog", "tools", asList());
			return;
		default:
			throw new EntityValidationError(`Unknown entity field "${key}"`);
	}
}

/**
 * Patch fields on an existing entity record. Reads the record, applies each
 * `key=value` update to its frontmatter (body preserved verbatim), re-validates
 * the whole record, and writes it back. Throws if the record does not exist or
 * the patched record would be invalid.
 */
export async function updateEntityRecordFields(
	name: string,
	updates: Array<{ key: string; value: string }>,
	options: WriteRegistryOptions = {},
): Promise<WriteEntityRecordResult> {
	const registry = await resolveTargetRegistry(options);
	const filePath = recordPath(name, registry.root);
	let content: string;
	try {
		content = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) throw new EntityValidationError(`No entity record for "${name}" at ${filePath}`, filePath);
		throw error;
	}
	const { frontmatter, body } = parseFrontmatter(content, { location: filePath, level: "fatal" });
	for (const { key, value } of updates) applyEntityFieldUpdate(frontmatter, key, value);
	const next = serializeEntityRecord(frontmatter, body);
	// Re-validate the patched record (schema, policy, declared-registry, bank namespace) before persisting.
	const validated = parseEntityRecord(filePath, next, "user", registry.id);
	enforceBankNamespace(validated.memory.bank, registry.id, registry.visibility, filePath);
	if (validated.name !== name) {
		throw new EntityValidationError(
			`Patched record name "${validated.name}" no longer matches filename "${name}.md"`,
			filePath,
		);
	}
	await fs.writeFile(filePath, next, "utf8");
	return { name, filePath, created: false };
}
