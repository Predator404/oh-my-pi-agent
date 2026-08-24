/**
 * Entity registry record schema — contract C1.
 *
 * A persistent entity is a named, individually-configured participant in the
 * multi-entity runtime (SPEC §4.1, §5). Its on-disk record extends OMP's
 * existing agent-definition frontmatter (the same shape loaded today from
 * `~/.omp/agent/agents/*.md`) with the formal role/memory/vault fields that
 * drive persistence and retention policy. Records live in the repo-2 registry
 * (lightweight Markdown + YAML frontmatter); the full system prompt is loaded
 * on demand at launch, never eagerly during roster discovery.
 *
 * Reused OMP fields: name, description, model, systemPrompt, tools,
 * autoloadSkills, thinkingLevel. New/formalized C1 fields: role, memory,
 * vaultSection, watchdog, hosting.
 */
import type { AdvisorConfig } from "../advisor/config";
import type { ThemeColor } from "../modes/theme/schema";
import type { AgentSource } from "../task/types";
import type { ConfiguredThinkingLevel } from "../thinking";

/**
 * Formal role enum. Drives the memory-retention policy, not the capability
 * ceiling (SPEC §2, §4.1):
 * - `agent`  — generalist/coordinator; retains episodic memory across sessions.
 * - `persona` — narrow specialist; retains only curated domain lessons
 *   (deliberate writes), never automatic per-turn episodic capture.
 */
export type EntityRole = "agent" | "persona";

/** The only supported memory backend today (SPEC §4.2). */
export const ENTITY_MEMORY_BACKENDS = ["mnemopi"] as const;
export type EntityMemoryBackend = (typeof ENTITY_MEMORY_BACKENDS)[number];

/**
 * Per-entity memory-bank binding (contract C2 consumes `backend`/`bank`).
 * `autoRetain` is the retention-policy switch enforced against {@link EntityRole}
 * at load: only `role: agent` may set it `true`; a `persona` is curated-only.
 */
export interface EntityMemory {
	backend: EntityMemoryBackend;
	/** Bank name the memory MCP (WS3) binds `recall(bank, …)` / `retain(bank, …)` to. */
	bank: string;
	/**
	 * When `true`, episodic turns are auto-retained across sessions (agent-tier,
	 * SPEC §4.2). MUST be `false` for `role: persona` — enforced at load, never
	 * silently coerced.
	 */
	autoRetain: boolean;
}

/**
 * Optional local/cloud model pin (SPEC §9). `modelEndpoint` is a provider id
 * registered in OMP's model registry (local OpenAI-compatible endpoint or a
 * cloud provider); the credentials/base-URL live in OMP provider config, not in
 * the record. Placement is deferred (SPEC resolved-item 5) — absent by default.
 */
export interface EntityHosting {
	modelEndpoint?: string;
}

/**
 * A standing-advisor entry attached to an entity, using OMP's native
 * `WATCHDOG.yml` advisor-config shape verbatim ({@link AdvisorConfig}).
 */
export type EntityWatchdog = AdvisorConfig;

/**
 * Lightweight entity-record metadata: every C1 field parsed from the record
 * frontmatter EXCEPT the full system prompt. This is the roster-scan view —
 * cheap to hold for every entity, holding no eagerly-loaded prompt body (SPEC
 * §5 context-cost discipline).
 */
export interface EntityRecordMeta {
	/** Unique, stable, filesystem-safe id (`^[a-z0-9][a-z0-9._-]*$`). */
	name: string;
	description: string;
	role: EntityRole;
	/** Optional single display glyph (emoji or char) marking this entity in the UI. */
	icon?: string;
	/** Optional theme-color token tinting this entity's label/marker. */
	color?: ThemeColor;
	/** OMP model selector list (per-entity; may target a local endpoint). */
	model?: string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	/** OMP tool grant list (built-in + MCP tool surface). */
	tools?: string[];
	autoloadSkills?: string[];
	memory: EntityMemory;
	/** Owned vault subtree, e.g. `agents/<name>` | `personas/<name>` (SPEC §7). */
	vaultSection: string;
	/**
	 * Home registry id (ADR 0004) — the registry this record belongs to and a key
	 * into the registries manifest. Populated by the loader from the registry the
	 * record was found in; frontmatter MAY declare it, but a declared value must
	 * match the record's actual registry.
	 */
	registry: string;
	watchdog?: EntityWatchdog;
	hosting?: EntityHosting;
	/** Provenance: registry records are user-owned data (repo 2). */
	source: AgentSource;
	filePath: string;
}

/**
 * A fully-loaded entity record: metadata plus the on-demand system-prompt body
 * (the record's Markdown body). Produced only at launch/resolution, never
 * during roster discovery.
 */
export interface EntityRecord extends EntityRecordMeta {
	/** Identity/voice/remit — loaded on demand from the record body. */
	systemPrompt: string;
}

/**
 * Launchable session config resolved from an entity record. This is the
 * WS2→WS1 seam: `resolveEntityConfig(name)` returns it, and WS1's resident
 * worker launch maps it onto OMP's `CreateAgentSessionOptions`
 * (`model`→`modelPattern`, `systemPrompt`→`customSystemPrompt`,
 * `tools`→`toolNames`, `thinkingLevel`→`thinkingLevel`, `cwd`→`cwd`).
 *
 * The retention policy is already enforced at load, so `memory.autoRetain` here
 * is guaranteed consistent with `role` (a `persona` never carries `true`).
 */
export interface ResolvedEntityConfig {
	name: string;
	description: string;
	role: EntityRole;
	icon?: string;
	color?: ThemeColor;
	model?: string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	systemPrompt: string;
	tools?: string[];
	autoloadSkills?: string[];
	memory: EntityMemory;
	vaultSection: string;
	/** Home registry id (ADR 0004): resolves the writable vault root + readable set + records root. */
	registry: string;
	watchdog?: EntityWatchdog;
	hosting?: EntityHosting;
	/**
	 * Working directory for the worker's AgentSession. Threaded from the launch
	 * context (`opts.cwd`); when undefined the worker defaults to a per-entity
	 * home. Records carry no fixed cwd — entities are project-agnostic; project
	 * binding is done through project pointers (WS6).
	 */
	cwd?: string;
	source: { filePath: string };
}
