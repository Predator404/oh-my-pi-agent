/**
 * Project pointer + skills/context wiring — WS6 (SPEC §7.3, §12.6).
 *
 * A project repo stays thin: instead of copying an entity's project knowledge
 * into the repo, it carries a *pointer stub* — a native OMP skill whose body is
 * a single `@`-import of the vault note that actually holds the content:
 *
 *     .omp/skills/<persona>-project/SKILL.md
 *     ---
 *     name: <persona>-project
 *     description: ...
 *     ---
 *     @~/vault/projects/<project>/<persona>.md
 *
 * The content lives once in the vault (`~/vault/projects/<project>/<persona>.md`);
 * the stub is resolved at read time through OMP's native `@`-import expansion
 * (`discovery/at-imports.ts`, wired into `buildSkillPromptMessage`). That
 * expander resolves `~/` to home, so the stub follows the per-machine `~/vault`
 * symlink to wherever the vault physically lives — sibling checkout, external
 * drive, synced folder. WS7a's setup owns creating/validating that symlink;
 * this module only consumes it.
 *
 * The `<persona>` segment is derived from the entity's C1 `vaultSection`
 * (`personas/<name>` | `agents/<name>`), resolved via WS2's `resolveEntityConfig`.
 * Once generated, the stub is surfaced into context by listing its skill name
 * (`<persona>-project`) in the entity's `autoloadSkills` (C1): the resident
 * worker runs in the project cwd, OMP's native skill discovery finds the stub
 * under `.omp/skills/`, and the autoload machinery injects its (now expanded)
 * body — no content ever duplicated into the project repo.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { type ResolveEntityOptions, resolveEntityConfig } from "../entity/loader";
import { SKILL_RESOLVE_IMPORTS_FIELD } from "../extensibility/skills";

/** Vault subtree that holds per-project notes (SPEC §4.3 / §7.3). */
export const VAULT_PROJECTS_DIR = "projects";

/**
 * The home-relative vault mount every pointer stub references. A per-machine
 * symlink `~/vault → <actual vault location>` (created by WS7a setup) keeps the
 * stub identical across machines and checkouts (SPEC §7.3, resolved-item 4).
 */
export const VAULT_HOME_MOUNT = "~/vault";

/** Project-root-relative directory where OMP discovers native project skills. */
export const PROJECT_SKILLS_DIR = path.join(".omp", "skills");

/** Skill name for an entity's project pointer: `<persona>-project`. */
export function projectSkillName(persona: string): string {
	return `${persona}-project`;
}

/**
 * The persona segment of a C1 `vaultSection` (`personas/phi` → `phi`,
 * `agents/atlas` → `atlas`). This is the identifier the vault project note and
 * the pointer stub are keyed on.
 */
export function personaFromVaultSection(vaultSection: string): string {
	const base = vaultSection
		.split(/[/\\]+/)
		.filter(Boolean)
		.pop();
	if (!base) {
		throw new Error(`Entity vaultSection ${JSON.stringify(vaultSection)} has no persona segment`);
	}
	return base;
}

/** Vault-relative path of a project note: `projects/<project>/<persona>.md`. */
export function vaultProjectNotePath(project: string, persona: string): string {
	return path.posix.join(VAULT_PROJECTS_DIR, project, `${persona}.md`);
}

/**
 * The `@`-import token a pointer stub's body carries:
 * `@~/vault/projects/<project>/<persona>.md` (SPEC §7.3).
 */
export function projectPointerImport(project: string, persona: string): string {
	return `@${VAULT_HOME_MOUNT}/${vaultProjectNotePath(project, persona)}`;
}

/** Default project id: the basename of the project root directory. */
export function projectIdFromDir(projectDir: string): string {
	return path.basename(path.resolve(projectDir));
}

/** Render options shared by the pure renderer and the on-disk generator. */
export interface RenderProjectPointerOptions {
	/** Vault project id (the `<project>` segment). */
	project: string;
	/** Persona/entity segment (the `<persona>` segment). */
	persona: string;
	/** Skill description; a project-scoped default is generated when omitted. */
	description?: string;
}

/**
 * Render the full stub file content (closed Agent-Skills frontmatter + a single
 * native `@`-import body). No content is copied — the body is only a pointer.
 */
export function renderProjectPointerStub(opts: RenderProjectPointerOptions): string {
	const project = opts.project.trim();
	const persona = opts.persona.trim();
	if (!project) throw new Error("renderProjectPointerStub: project is required");
	if (!persona) throw new Error("renderProjectPointerStub: persona is required");
	const skillName = projectSkillName(persona);
	const description =
		opts.description?.trim() ||
		`Project knowledge for ${persona} on ${project}, resolved at read time from the shared vault (${VAULT_HOME_MOUNT}/${vaultProjectNotePath(project, persona)}).`;
	// `description` is quoted as a JSON scalar — a valid YAML double-quoted flow
	// scalar — so newlines/colons/quotes in the text can never corrupt the
	// frontmatter (the native skill loader requires a non-empty description).
	// `resolveImports: true` is the opt-in flag `buildSkillPromptMessage` gates on
	// (SKILL_RESOLVE_IMPORTS_FIELD): only stubs carrying it get their `@`-import
	// body expanded at read time, so expansion stays scoped to project pointers.
	return `---\nname: ${skillName}\ndescription: ${JSON.stringify(description)}\n${SKILL_RESOLVE_IMPORTS_FIELD}: true\n---\n\n${projectPointerImport(project, persona)}\n`;
}

/** The stub a generation call produced or would produce. */
export interface ProjectPointerStub {
	/** Skill name (`<persona>-project`); also the `autoloadSkills` entry. */
	skillName: string;
	/** Absolute path of the `SKILL.md` stub. */
	skillPath: string;
	/** Full stub file content (frontmatter + `@`-import body). */
	content: string;
	/** Home-relative vault note the stub resolves to. */
	target: string;
	/** Vault-relative note path (`projects/<project>/<persona>.md`). */
	vaultNotePath: string;
	/** Resolved `<project>` segment. */
	project: string;
	/** Resolved `<persona>` segment. */
	persona: string;
}

export interface GenerateProjectPointerOptions {
	/** Project repo root the stub is written into. */
	projectDir: string;
	/** Persona/entity segment (e.g. `phi`). */
	persona: string;
	/** Vault project id; defaults to `basename(projectDir)`. */
	project?: string;
	/** Skill description; a project-scoped default is generated when omitted. */
	description?: string;
}

export interface GenerateProjectPointerResult extends ProjectPointerStub {
	/** `true` when the stub file did not exist before this call. */
	created: boolean;
	/** `true` when the on-disk content changed (create or content update). */
	changed: boolean;
}

/**
 * Write (idempotently) an entity's project-pointer stub into a project repo at
 * `<projectDir>/.omp/skills/<persona>-project/SKILL.md`. Re-running with the
 * same inputs is a no-op (`changed: false`) — never a clobber. The stub carries
 * only the `@`-import pointer; the knowledge itself stays in the vault.
 */
export async function generateProjectPointer(
	opts: GenerateProjectPointerOptions,
): Promise<GenerateProjectPointerResult> {
	const persona = opts.persona.trim();
	if (!persona) throw new Error("generateProjectPointer: persona is required");
	const project = opts.project?.trim() || projectIdFromDir(opts.projectDir);
	const skillName = projectSkillName(persona);
	const skillDir = path.resolve(opts.projectDir, PROJECT_SKILLS_DIR, skillName);
	const skillPath = path.join(skillDir, "SKILL.md");
	const content = renderProjectPointerStub({ project, persona, description: opts.description });

	const existing = await readFile(skillPath, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	const created = existing === null;
	const changed = existing !== content;
	if (changed) {
		await mkdir(skillDir, { recursive: true });
		await writeFile(skillPath, content, "utf8");
	}
	return {
		skillName,
		skillPath,
		content,
		target: `${VAULT_HOME_MOUNT}/${vaultProjectNotePath(project, persona)}`,
		vaultNotePath: vaultProjectNotePath(project, persona),
		project,
		persona,
		created,
		changed,
	};
}

export interface GenerateProjectPointerForEntityOptions extends ResolveEntityOptions {
	/** Project repo root the stub is written into. */
	projectDir: string;
	/** Registry entity name to resolve (C1). */
	entityName: string;
	/** Vault project id; defaults to `basename(projectDir)`. */
	project?: string;
	/** Override the stub description; defaults to a project-scoped one. */
	description?: string;
}

/**
 * Resolve an entity's C1 record (WS2 `resolveEntityConfig`), derive its persona
 * from `vaultSection`, and generate the project-pointer stub. This is the seam
 * WS7's CLI drives to wire a project to an entity's vault section.
 */
export async function generateProjectPointerForEntity(
	opts: GenerateProjectPointerForEntityOptions,
): Promise<GenerateProjectPointerResult> {
	const config = await resolveEntityConfig(opts.entityName, { registryRoot: opts.registryRoot });
	const persona = personaFromVaultSection(config.vaultSection);
	return generateProjectPointer({
		projectDir: opts.projectDir,
		project: opts.project,
		persona,
		description: opts.description,
	});
}
