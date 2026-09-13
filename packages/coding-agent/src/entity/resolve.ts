/**
 * Thin entity config resolver — validates OMA fields on an AgentDefinition
 * and produces a launchable ResolvedEntityConfig. Replaces the old 522-line
 * entity/loader.ts; discovery now happens through task/discovery.ts's
 * `discoverAgents()` which already scans the OMA registry root.
 */
import { isValidThemeColor } from "../modes/theme/schema";
import type { AgentDefinition, ResolvedEntityConfig } from "../task/types";

/** An entity record is missing or has invalid OMA fields. */
export class EntityConfigError extends Error {
	constructor(
		message: string,
		readonly entityName: string,
	) {
		super(`Entity "${entityName}": ${message}`);
		this.name = "EntityConfigError";
	}
}

const VALID_ROLES = ["agent", "persona"] as const;
const VALID_MEMORY_BACKENDS = ["mnemopi"] as const;
const ENTITY_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ICON_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Resolve an AgentDefinition into a launchable ResolvedEntityConfig.
 * Validates all OMA fields with the same rigour as the old parseEntityMeta.
 */
export function resolveEntityConfig(agent: AgentDefinition, registryVisibility?: "public" | "private"): ResolvedEntityConfig {
	const name = agent.name;
	if (!name || !ENTITY_NAME_PATTERN.test(name)) {
		throw new EntityConfigError(`name must be a filesystem-safe id matching /^[a-z0-9][a-z0-9._-]*$/`, name ?? "<empty>");
	}

	const role = agent.role;
	if (!role || !(VALID_ROLES as readonly string[]).includes(role)) {
		throw new EntityConfigError(`role must be one of ${VALID_ROLES.map(r => `"${r}"`).join(" | ")}`, name);
	}

	const systemPrompt = agent.systemPrompt?.trim();
	if (!systemPrompt) {
		throw new EntityConfigError("system prompt must be non-empty", name);
	}

	// icon — single grapheme, no whitespace
	if (agent.icon !== undefined) {
		const icon = agent.icon.trim();
		if (!icon || /\s/.test(icon) || [...ICON_GRAPHEME_SEGMENTER.segment(icon)].length !== 1) {
			throw new EntityConfigError("icon must be a single display glyph with no whitespace", name);
		}
	}

	// color — valid theme-color token
	if (agent.color !== undefined && !isValidThemeColor(agent.color)) {
		throw new EntityConfigError(`color must be a theme-color token (e.g. accent, success, warning, error)`, name);
	}

	const memory = agent.memory;
	if (!memory?.bank) {
		throw new EntityConfigError("memory.bank must be a non-empty string", name);
	}
	if (!(VALID_MEMORY_BACKENDS as readonly string[]).includes(memory.backend)) {
		throw new EntityConfigError(`memory.backend must be one of ${VALID_MEMORY_BACKENDS.map(b => `"${b}"`).join(" | ")}`, name);
	}

	const vaultSection = agent.vaultSection;
	if (!vaultSection) {
		throw new EntityConfigError("vaultSection must be a non-empty string", name);
	}

	const registry = agent.registry ?? "oma";

	// Retention policy: persona cannot auto-retain — reject, don't silently coerce
	let autoRetain = memory.autoRetain;
	if (role === "persona" && autoRetain) {
		throw new EntityConfigError(
			`role "persona" cannot set memory.autoRetain: true — personas are curated-only (set role: agent for episodic retention)`,
			name,
		);
	}

	// Bank namespace for private registries
	let bank = memory.bank;
	if (registryVisibility === "private" && !bank.startsWith(`${registry}/`)) {
		bank = `${registry}/${bank}`;
	}

	return {
		name,
		description: agent.description,
		role,
		icon: agent.icon,
		color: agent.color,
		model: agent.model,
		thinkingLevel: agent.thinkingLevel,
		systemPrompt,
		tools: agent.tools,
		autoloadSkills: agent.autoloadSkills,
		memory: { backend: "mnemopi", bank, autoRetain },
		vaultSection,
		registry,
		watchdog: agent.watchdog,
		hosting: agent.hosting,
		source: { filePath: agent.filePath ?? "" },
	};
}

/** Options for {@link resolveEntityByName}. */
export interface ResolveEntityByNameOptions {
	registryVisibility?: "public" | "private";
	/** Working directory threaded from the launch context. */
	cwd?: string;
}

/**
 * Resolve an entity by name from discovered agents. Returns the resolved
 * config or throws EntityConfigError if the entity is missing required fields.
 */
export function resolveEntityByName(
	agents: AgentDefinition[],
	name: string,
	opts: ResolveEntityByNameOptions = {},
): ResolvedEntityConfig {
	const agent = agents.find(a => a.name === name);
	if (!agent) throw new EntityConfigError("entity not found in registry", name);
	const config = resolveEntityConfig(agent, opts.registryVisibility);
	if (opts.cwd !== undefined) config.cwd = opts.cwd;
	return config;
}
