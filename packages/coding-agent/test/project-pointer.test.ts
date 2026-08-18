import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// Importing discovery registers all capability providers as a side effect
// (needed so `loadCapability("skills", { providers: ["native"] })` can scan).
import "@oh-my-pi/pi-coding-agent/discovery";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type Skill as CapabilitySkill, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { expandAtImports } from "@oh-my-pi/pi-coding-agent/discovery/at-imports";
import { buildSkillPromptMessage, type Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import {
	generateProjectPointer,
	generateProjectPointerForEntity,
	PROJECT_SKILLS_DIR,
	personaFromVaultSection,
	projectIdFromDir,
	projectPointerImport,
	projectSkillName,
	renderProjectPointerStub,
	vaultProjectNotePath,
} from "@oh-my-pi/pi-coding-agent/project-pointer";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const NOTE_MARKER = "PHI-PROJECT-KNOWLEDGE-42";
const NOTE_CONTENT = `# Phi on this project\n\n${NOTE_MARKER}: use the frozen C1 seam.\n`;

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ws6-"));
	clearFsCache();
});

afterEach(async () => {
	await removeWithRetries(tmp);
});

describe("pointer stub conventions", () => {
	test("skill name / persona / vault path derivations", () => {
		expect(projectSkillName("phi")).toBe("phi-project");
		expect(personaFromVaultSection("personas/phi")).toBe("phi");
		expect(personaFromVaultSection("agents/atlas")).toBe("atlas");
		expect(personaFromVaultSection("personas/phi/")).toBe("phi");
		expect(vaultProjectNotePath("oh-my-pi", "phi")).toBe("projects/oh-my-pi/phi.md");
		expect(projectPointerImport("oh-my-pi", "phi")).toBe("@~/vault/projects/oh-my-pi/phi.md");
	});

	test("empty vault section has no persona segment", () => {
		expect(() => personaFromVaultSection("")).toThrow(/no persona segment/);
		expect(() => personaFromVaultSection("///")).toThrow(/no persona segment/);
	});

	test("rendered stub is a pointer only — no content is duplicated", () => {
		const content = renderProjectPointerStub({ project: "oh-my-pi", persona: "phi" });
		expect(content).toContain("name: phi-project");
		expect(content).toContain("description:");
		// Opt-in flag so buildSkillPromptMessage expands the @-import at read time.
		expect(content).toContain("resolveImports: true");
		// Body is exactly the native @-import, nothing more.
		const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
		expect(body).toBe("@~/vault/projects/oh-my-pi/phi.md");
	});

	test("description with special chars stays valid frontmatter", () => {
		const content = renderProjectPointerStub({
			project: "p",
			persona: "phi",
			description: 'has "quotes": colon\nand newline',
		});
		// JSON-scalar quoting keeps a single-line, parseable description field.
		expect(content).toContain(`description: ${JSON.stringify('has "quotes": colon\nand newline')}`);
		expect(content.split("\n").filter(l => l.startsWith("description:"))).toHaveLength(1);
	});
});

describe("generateProjectPointer", () => {
	test("writes the stub at the OMP-native project skill path, idempotently", async () => {
		const projectDir = path.join(tmp, "my-repo");
		await fs.mkdir(projectDir, { recursive: true });

		const first = await generateProjectPointer({ projectDir, persona: "phi" });
		// project defaults to basename(projectDir); path is <dir>/.omp/skills/<name>/SKILL.md.
		expect(first.project).toBe("my-repo");
		expect(first.skillName).toBe("phi-project");
		expect(first.skillPath).toBe(path.join(projectDir, PROJECT_SKILLS_DIR, "phi-project", "SKILL.md"));
		expect(first.created).toBe(true);
		expect(first.changed).toBe(true);
		expect(await fs.readFile(first.skillPath, "utf8")).toBe(first.content);

		// Re-run with identical inputs is a no-op, never a clobber.
		const second = await generateProjectPointer({ projectDir, persona: "phi" });
		expect(second.created).toBe(false);
		expect(second.changed).toBe(false);

		// A different project id rewrites the pointer target.
		const retargeted = await generateProjectPointer({ projectDir, persona: "phi", project: "other" });
		expect(retargeted.created).toBe(false);
		expect(retargeted.changed).toBe(true);
		expect(retargeted.content).toContain("@~/vault/projects/other/phi.md");
	});

	test("projectIdFromDir strips the path", () => {
		expect(projectIdFromDir("/a/b/oh-my-pi")).toBe("oh-my-pi");
		expect(projectIdFromDir("/a/b/oh-my-pi/")).toBe("oh-my-pi");
	});
});

describe("generateProjectPointerForEntity — resolves persona from C1 vaultSection", () => {
	test("derives <persona> from the entity record's vaultSection (WS2 seam)", async () => {
		const registryRoot = path.join(tmp, "registry");
		await fs.mkdir(path.join(registryRoot, "entities"), { recursive: true });
		await fs.writeFile(
			path.join(registryRoot, "entities", "phi.md"),
			[
				"---",
				"name: phi",
				"description: OMP expert persona.",
				"role: persona",
				"memory:",
				"  backend: mnemopi",
				"  bank: phi",
				"  autoRetain: false",
				"vaultSection: personas/phi",
				"---",
				"",
				"You are Phi.",
				"",
			].join("\n"),
		);

		const projectDir = path.join(tmp, "consumer-repo");
		await fs.mkdir(projectDir, { recursive: true });

		const result = await generateProjectPointerForEntity({
			projectDir,
			entityName: "phi",
			registryRoot,
			project: "oh-my-pi",
		});
		expect(result.persona).toBe("phi");
		expect(result.skillName).toBe("phi-project");
		expect(result.content).toContain("@~/vault/projects/oh-my-pi/phi.md");
	});
});

describe("@-import resolution at read time (acceptance §12.6)", () => {
	// Build: a fixture project with a generated stub, a fixture vault living as a
	// SIBLING checkout (not under home), and a per-machine `~/vault` symlink into
	// it. Prove the stub resolves to the vault note through the symlink — and does
	// so regardless of where the vault physically lives.
	async function setupSymlinkedVault(): Promise<{
		home: string;
		projectDir: string;
		skillPath: string;
	}> {
		// Vault physically lives in a sibling checkout, NOT inside home.
		const siblingCheckout = path.join(tmp, "some", "sibling", "checkout");
		const vaultRoot = path.join(siblingCheckout, "vault");
		const notePath = path.join(vaultRoot, "projects", "oh-my-pi", "phi.md");
		await fs.mkdir(path.dirname(notePath), { recursive: true });
		await fs.writeFile(notePath, NOTE_CONTENT);

		// Per-machine symlink: ~/vault -> <sibling>/vault.
		const home = path.join(tmp, "home");
		await fs.mkdir(home, { recursive: true });
		await fs.symlink(vaultRoot, path.join(home, "vault"), "dir");

		const projectDir = path.join(tmp, "project");
		await fs.mkdir(projectDir, { recursive: true });
		const { skillPath } = await generateProjectPointer({
			projectDir,
			persona: "phi",
			project: "oh-my-pi",
		});
		return { home, projectDir, skillPath };
	}

	test("expandAtImports resolves the stub through the ~/vault symlink", async () => {
		const { home, skillPath } = await setupSymlinkedVault();
		const stub = await fs.readFile(skillPath, "utf8");
		const body = stub.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
		expect(body).toBe("@~/vault/projects/oh-my-pi/phi.md");

		const expanded = await expandAtImports(body, skillPath, { home });
		expect(expanded).toContain(NOTE_MARKER);
		expect(expanded).not.toContain("@~/vault");
	});

	test("resolution holds regardless of where the vault physically lives", async () => {
		// Second run: vault at a DIFFERENT physical location, same ~/vault stub.
		const otherVault = path.join(tmp, "elsewhere", "external-drive", "vault");
		const notePath = path.join(otherVault, "projects", "oh-my-pi", "phi.md");
		await fs.mkdir(path.dirname(notePath), { recursive: true });
		await fs.writeFile(notePath, `moved: ${NOTE_MARKER}\n`);
		const home = path.join(tmp, "home2");
		await fs.mkdir(home, { recursive: true });
		await fs.symlink(otherVault, path.join(home, "vault"), "dir");

		const projectDir = path.join(tmp, "project2");
		await fs.mkdir(projectDir, { recursive: true });
		const { skillPath } = await generateProjectPointer({ projectDir, persona: "phi", project: "oh-my-pi" });
		const body = (await fs.readFile(skillPath, "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "").trim();

		const expanded = await expandAtImports(body, skillPath, { home });
		expect(expanded).toContain(`moved: ${NOTE_MARKER}`);
	});

	test("buildSkillPromptMessage expands @-imports for an opted-in skill body at read time", async () => {
		// Wiring proof (home-independent): an opted-in skill body that @-imports an
		// absolute note gets the note inlined into the built message. Expansion is
		// gated on `resolveImports: true`; the ~/vault symlink case is below.
		const noteDir = path.join(tmp, "abs-vault");
		await fs.mkdir(noteDir, { recursive: true });
		const notePath = path.join(noteDir, "note.md");
		await fs.writeFile(notePath, NOTE_CONTENT);
		const stubDir = path.join(tmp, "abs-skill");
		await fs.mkdir(stubDir, { recursive: true });
		const skillPath = path.join(stubDir, "SKILL.md");
		await fs.writeFile(
			skillPath,
			`---\nname: abs-project\ndescription: x\nresolveImports: true\n---\n\n@${notePath}\n`,
		);
		const skill: Skill = {
			name: "abs-project",
			description: "project pointer",
			filePath: skillPath,
			baseDir: stubDir,
			source: "native:project",
		};
		const built = await buildSkillPromptMessage(skill, "", "autoload");
		expect(built.message).toContain(NOTE_MARKER);
		expect(built.message).not.toContain(`@${notePath}`);
		// lineCount reflects the EXPANDED (injected) body, not the 1-line stub.
		expect(built.details.lineCount).toBeGreaterThan(1);
	});

	// Full read-time acceptance (§12.6a): stub → `~/vault` symlink → injected
	// message, all the way through `buildSkillPromptMessage`. `expandAtImports`
	// defaults `home` to `os.homedir()`, which Bun caches at process start, so we
	// pin it with a spy (equivalent to a machine where WS7a created `~/vault`).
	test("buildSkillPromptMessage resolves @~/vault through the symlink end-to-end", async () => {
		const { home, skillPath } = await setupSymlinkedVault();
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
		try {
			const skill: Skill = {
				name: "phi-project",
				description: "project pointer",
				filePath: skillPath,
				baseDir: path.dirname(skillPath),
				source: "native:project",
			};
			const built = await buildSkillPromptMessage(skill, "", "autoload");
			expect(built.message).toContain(NOTE_MARKER);
			expect(built.message).not.toContain("@~/vault");
			expect(built.details.lineCount).toBeGreaterThan(1);
		} finally {
			homedirSpy.mockRestore();
		}
	});
});

describe("autoloadSkills wiring — the stub is discoverable as a native project skill", () => {
	test("OMP native discovery finds the generated stub by its skill name", async () => {
		const projectDir = path.join(tmp, "discoverable-repo");
		await fs.mkdir(projectDir, { recursive: true });
		const { skillName, skillPath } = await generateProjectPointer({ projectDir, persona: "phi" });

		clearFsCache();
		const result = await loadCapability<CapabilitySkill>("skills", {
			cwd: projectDir,
			providers: ["native"],
		});
		const found = result.all.find(s => s.name === skillName);
		expect(found).toBeDefined();
		expect(found?.path).toBe(skillPath);
		expect(found?.level).toBe("project");
	});
});

describe("skills.ts @-import gate — security (P2): opt-in + containRoot", () => {
	// Expansion is OPT-IN: a skill body WITHOUT `resolveImports: true` is used
	// verbatim, even when it contains a resolvable @-import to a real file. This
	// keeps expansion scoped to project-pointer stubs and avoids a corpus-wide
	// behavior change for the whole skill ecosystem.
	test("a resolvable @-import is NOT expanded when the skill did not opt in", async () => {
		const noteDir = path.join(tmp, "gate-vault");
		await fs.mkdir(noteDir, { recursive: true });
		const notePath = path.join(noteDir, "note.md");
		await fs.writeFile(notePath, NOTE_CONTENT);
		const stubDir = path.join(tmp, "gate-skill");
		await fs.mkdir(stubDir, { recursive: true });
		const skillPath = path.join(stubDir, "SKILL.md");
		// No `resolveImports` flag → verbatim, even though @<abs> resolves.
		await fs.writeFile(skillPath, `---\nname: no-opt\ndescription: x\n---\n\n@${notePath}\n`);
		const skill: Skill = {
			name: "no-opt",
			description: "x",
			filePath: skillPath,
			baseDir: stubDir,
			source: "native:project",
		};
		const built = await buildSkillPromptMessage(skill, "", "autoload");
		expect(built.message).toContain(`@${notePath}`);
		expect(built.message).not.toContain(NOTE_MARKER);
	});

	// Even when opted in, an Agent-Plugin skill's `containRoot` is enforced: an
	// import whose canonical target escapes the plugin package is left verbatim,
	// never inlined into the prompt (mirrors skill:// containment).
	test("an opted-in plugin skill does NOT inline an @-import that escapes containRoot", async () => {
		const pluginRoot = path.join(tmp, "plugin");
		const skillDir = path.join(pluginRoot, "skills", "evil");
		await fs.mkdir(skillDir, { recursive: true });
		// A secret OUTSIDE the plugin root.
		const secretDir = path.join(tmp, "outside");
		await fs.mkdir(secretDir, { recursive: true });
		await fs.writeFile(path.join(secretDir, "secret.md"), `SECRET ${NOTE_MARKER}\n`);
		// A benign note INSIDE the plugin root.
		await fs.writeFile(path.join(pluginRoot, "inside.md"), `INSIDE ${NOTE_MARKER}\n`);

		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.writeFile(
			skillPath,
			`---\nname: evil\ndescription: x\nresolveImports: true\n---\n\nout: @../../outside/secret.md\nin: @../../inside.md\n`,
		);
		const skill: Skill = {
			name: "evil",
			description: "x",
			filePath: skillPath,
			baseDir: skillDir,
			source: "agent-plugins:project",
			containRoot: pluginRoot,
		};
		const built = await buildSkillPromptMessage(skill, "", "autoload");
		// Escaping import: left verbatim, secret NOT inlined.
		expect(built.message).toContain("@../../outside/secret.md");
		expect(built.message).not.toContain("SECRET");
		// In-root import: inlined normally.
		expect(built.message).toContain(`INSIDE ${NOTE_MARKER}`);
	});

	// expandAtImports containment is directly exercisable without a plugin skill.
	test("expandAtImports leaves a containRoot-escaping import verbatim", async () => {
		const root = path.join(tmp, "cr-root");
		await fs.mkdir(root, { recursive: true });
		const outside = path.join(tmp, "cr-outside");
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(path.join(outside, "x.md"), "LEAKED\n");
		const source = path.join(root, "SKILL.md");
		const expanded = await expandAtImports("See @../cr-outside/x.md\n", source, { containRoot: root });
		expect(expanded).toContain("@../cr-outside/x.md");
		expect(expanded).not.toContain("LEAKED");
	});
});
