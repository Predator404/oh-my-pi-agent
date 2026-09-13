/**
 * Agent discovery from filesystem.
 *
 * Discovers agent definitions from OMP-native task-agent roots:
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *   - <ext>/agents/*.md for every OMP extension package wired through
 *     `listOmpExtensionRoots` (CLI `--extension` roots, `extensions:` in
 *     settings, and enabled npm/link plugins under `<plugins>/node_modules/`).
 *     Mirrors the same sub-discovery convention applied to `skills/`,
 *     `hooks/`, `tools/`, etc. by `discovery/omp-plugins.ts`.
 *
 * Claude Code marketplace plugin agents are discovered separately via the
 * claude-plugins provider. Direct cross-harness roots such as .claude/agents
 * are intentionally skipped because their frontmatter schema is not the OMP
 * task-agent contract.
 *
 * OMA persistent-entity records are discovered from the entity registry root
 * (`OMP_ENTITY_REGISTRY` env or `<agentDir>/registry/entities/*.md`). Entity
 * records share the same Markdown+YAML frontmatter format as agent definitions
 * with additional OMA-specific fields (role, memory, vaultSection, registry,
 * watchdog, hosting, icon, color).
 *
 * Agent files use markdown with YAML frontmatter.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isRecord, logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { isProviderEnabled, isUserSourceEnabled } from "../capability";
import type { EffectiveExtensionRoots } from "../capability/types";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { listClaudePluginRoots, parseArrayOrCSV, parseBoolean, parseModelList } from "../discovery/helpers";
import { listOmpExtensionRoots } from "../discovery/omp-extension-roots";
import { isValidThemeColor, type ThemeColor } from "../modes/theme/schema";
import { parseConfiguredThinkingLevel } from "../thinking";
import { normalizeToolNames } from "../tools/builtin-names";
import { loadBundledAgents, parseAgent } from "./agents";
import type { AgentDefinition, AgentSource } from "./types";

const TASK_AGENT_CONFIG_SOURCE = ".omp";

/** Environment variable that overrides the default entity-registry root. */
const ENTITY_REGISTRY_ENV = "OMP_ENTITY_REGISTRY";
/** Directory under the registry root holding one Markdown record per entity. */
const ENTITY_RECORDS_SUBDIR = "entities";
/** Filesystem-/id-safe entity name pattern. */
const ENTITY_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const VALID_ROLES = ["agent", "persona"] as const;
const VALID_MEMORY_BACKENDS = ["mnemopi"] as const;

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
	/** Non-fatal load errors from entity record parsing (OMA only; empty for stock OMP). */
	errors: Array<{ filePath: string; error: string }>;
}

/**
 * Load agents from a directory.
 */
async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(file => {
			const filePath = path.join(dir, file.name);
			return fs
				.readFile(filePath, "utf-8")
				.then(content => parseAgent(filePath, content, source, "warn"))
				.catch(error => {
					logger.warn("Failed to read agent file", { filePath, error });
					return null;
				});
		});

	return (await Promise.all(files)).filter(Boolean) as AgentDefinition[];
}

/**
 * Resolve the OMA entity-registry root: `OMP_ENTITY_REGISTRY` env var,
 * else `<agentDir>/registry`.
 */
function getEntityRegistryRoot(): string {
	const env = process.env[ENTITY_REGISTRY_ENV]?.trim();
	if (env) return path.resolve(env);
	return path.join(getAgentDir(), "registry");
}

/**
 * Parse OMA-specific frontmatter fields and enrich an AgentDefinition.
 * Only called when an entity registry root exists — never on stock OMP agents.
 */
function enrichEntityFields(agent: AgentDefinition, frontmatter: Record<string, unknown>, filePath: string): void {
	// role
	const rawRole = frontmatter.role;
	if (typeof rawRole === "string" && VALID_ROLES.includes(rawRole as "agent" | "persona")) {
		agent.role = rawRole as "agent" | "persona";
	}

	// icon — single grapheme
	const rawIcon = frontmatter.icon;
	if (typeof rawIcon === "string" && rawIcon.trim()) {
		const icon = rawIcon.trim();
		const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(icon)];
		if (graphemes.length === 1 && !/\s/.test(icon)) agent.icon = icon;
	}

	// color — theme-color token
	const rawColor = frontmatter.color;
	if (typeof rawColor === "string" && rawColor.trim()) {
		const color = rawColor.trim();
		if (isValidThemeColor(color)) agent.color = color;
	}

	// memory
	const rawMemory = frontmatter.memory;
	if (isRecord(rawMemory)) {
		const backend = rawMemory.backend;
		const bank = rawMemory.bank;
		if (typeof backend === "string" && VALID_MEMORY_BACKENDS.includes(backend as "mnemopi") &&
			typeof bank === "string" && bank.trim()) {
			let autoRetain = false;
			if (rawMemory.autoRetain !== undefined) {
				const parsed = parseBoolean(rawMemory.autoRetain);
				if (parsed !== undefined) autoRetain = parsed;
			}
			// Retention policy: persona cannot auto-retain
			if (agent.role === "persona" && autoRetain) autoRetain = false;
			agent.memory = { backend: backend as "mnemopi", bank: bank.trim(), autoRetain };
		}
	}

	// vaultSection
	const rawVault = frontmatter.vaultSection;
	if (typeof rawVault === "string" && rawVault.trim()) {
		agent.vaultSection = rawVault.trim();
	}

	// registry — set by the caller from the scan context
	// watchdog — parsed on-demand at launch; store raw for now
	const rawWatchdog = frontmatter.watchdog;
	if (isRecord(rawWatchdog) && typeof rawWatchdog.name === "string") {
		agent.watchdog = rawWatchdog as unknown as AdvisorConfig;
	}

	// hosting
	const rawHosting = frontmatter.hosting;
	if (isRecord(rawHosting)) {
		const endpoint = rawHosting.modelEndpoint;
		if (typeof endpoint === "string" && endpoint.trim()) {
			agent.hosting = { modelEndpoint: endpoint.trim() };
		}
	}
}

/**
 * Load entity records from the OMA entity registry root.
 * Returns both successfully-parsed agents and non-fatal load errors.
 */
async function loadEntityAgents(registryRoot: string): Promise<{ agents: AgentDefinition[]; errors: Array<{ filePath: string; error: string }> }> {
	const entitiesDir = path.join(registryRoot, ENTITY_RECORDS_SUBDIR);
	const entries = await fs.readdir(entitiesDir, { withFileTypes: true }).catch(() => []);
	const errors: Array<{ filePath: string; error: string }> = [];
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(async file => {
			const filePath = path.join(entitiesDir, file.name);
			try {
				const content = await fs.readFile(filePath, "utf-8");
				const agent = parseAgent(filePath, content, "user", "warn");
				const { frontmatter } = parseFrontmatter(content);
				enrichEntityFields(agent, frontmatter, filePath);
				agent.registry ??= "oma";
				return agent;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn("Failed to load entity record", { filePath, error: message });
				errors.push({ filePath, error: message });
				return null;
			}
		});

	const agents = (await Promise.all(files)).filter(Boolean) as AgentDefinition[];
	return { agents, errors };
}

/**
 * Discover agents from filesystem and merge with bundled agents.
 * Precedence (highest wins): project `.omp/agents`, user `.omp/agents`,
 * OMP extension-package agents from the effective `extensions` setting,
 * installed npm/link plugins, Claude marketplace plugin agents (project scope
 * before user), then bundled.
 * @param cwd - Current working directory for project agent discovery
 * @param home - Home directory for user and marketplace discovery
 * @param extensionRoots - Session-local extension roots (explicit + mode + configured)
 */
export async function discoverAgents(
	cwd: string,
	home: string = os.homedir(),
	extensionRoots?: EffectiveExtensionRoots,
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

	const userDirs = getConfigDirs("agents", { project: false })
		.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const projectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd)
		.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const orderedDirs: Array<{ dir: string; source: AgentSource }> = [];
	const project = projectDirs[0];
	if (project) orderedDirs.push({ dir: project.path, source: "project" });
	const user = userDirs[0];
	if (user) orderedDirs.push({ dir: user.path, source: "user" });

	// Extension-package agents use the same effective root set as sibling
	// skills/hooks/tools, threaded whole so explicit roots and mode survive.
	const packageRoots = isProviderEnabled("omp-plugins")
		? await listOmpExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null, extensionRoots })
		: [];
	for (const root of packageRoots) {
		orderedDirs.push({ dir: path.join(root.path, "agents"), source: root.level });
	}

	// Load agents from Claude Code marketplace plugins (respects disabledProviders and opt-in)
	const claudePluginsUserEnabled = isUserSourceEnabled("claude-plugins") || isUserSourceEnabled("claude");
	const { roots: pluginRoots } = isProviderEnabled("claude-plugins")
		? await listClaudePluginRoots(home, resolvedCwd)
		: { roots: [] };
	const filteredPluginRoots = claudePluginsUserEnabled ? pluginRoots : pluginRoots.filter(r => r.scope === "project");
	const sortedPluginRoots = [...filteredPluginRoots].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "project" ? -1 : 1;
	});
	for (const plugin of sortedPluginRoots) {
		const agentsDir = path.join(plugin.path, "agents");
		orderedDirs.push({ dir: agentsDir, source: plugin.scope === "project" ? "project" : "user" });
	}

	// OMA persistent-entity registry: scan `<registryRoot>/entities/*.md`.
	let entityAgents: AgentDefinition[] = [];
	let entityErrors: Array<{ filePath: string; error: string }> = [];
	try {
		const registryRoot = getEntityRegistryRoot();
		const entitiesDir = path.join(registryRoot, ENTITY_RECORDS_SUBDIR);
		const stat = await fs.stat(entitiesDir).catch(() => null);
		if (stat?.isDirectory()) {
			const result = await loadEntityAgents(registryRoot);
			entityAgents = result.agents;
			entityErrors = result.errors;
		}
	} catch {
		// Registry not configured or inaccessible — not an error for stock OMP.
	}

	const seen = new Set<string>();
	const loadedAgents = (await Promise.all(orderedDirs.map(({ dir, source }) => loadAgentsFromDir(dir, source))))
		.flat()
		.filter(agent => {
			if (seen.has(agent.name)) return false;
			seen.add(agent.name);
			return true;
		});

	// Entity agents have lowest precedence — any same-named agent from another
	// source wins. This lets a project-level agent override an entity record.
	for (const agent of entityAgents) {
		if (!seen.has(agent.name)) {
			seen.add(agent.name);
			loadedAgents.push(agent);
		}
	}

	const bundledAgents = loadBundledAgents().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const projectAgentsDir = projectDirs.length > 0 ? projectDirs[0].path : null;

	return { agents: [...loadedAgents, ...bundledAgents], projectAgentsDir, errors: entityErrors };
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}
