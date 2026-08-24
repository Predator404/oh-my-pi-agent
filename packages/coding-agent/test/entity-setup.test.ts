/**
 * WS7a — idempotent setup/bootstrap acceptance (SPEC §12.7a).
 * Fresh run yields a resolvable ~/vault, a loadable registry, and wired root;
 * re-running is a no-op (no "created"/"updated"), never a clobber.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { rewriteVaultPointerStubs, runEntitySetup, VAULT_SECTION_DIRS } from "@oh-my-pi/pi-coding-agent/entity";
import { YAML } from "bun";

let root: string;
let home: string;
let agentDir: string;
let registrySource: string;
let modelsConfigPath: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ws7a-"));
	home = path.join(root, "home");
	agentDir = path.join(root, "agent");
	registrySource = path.join(root, "registry-checkout");
	modelsConfigPath = path.join(agentDir, "models.yml");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(registrySource, { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const baseOptions = () => ({ registrySource, homeDir: home, agentDir, modelsConfigPath });

describe("runEntitySetup — fresh machine", () => {
	it("scaffolds registry, vault sections, and a resolvable ~/vault", async () => {
		const report = await runEntitySetup(baseOptions());

		expect(report.ok).toBe(true);
		expect(report.registryRoot).toBe(path.resolve(registrySource));
		expect(report.vaultLocation).toBe(path.resolve(path.join(registrySource, "vault")));

		// Registry root wired: <agentDir>/registry symlinks to the checkout.
		const linkTarget = await fs.readlink(path.join(agentDir, "registry"));
		expect(path.resolve(linkTarget)).toBe(path.resolve(registrySource));

		// entities/ scaffolded.
		expect((await fs.stat(path.join(registrySource, "entities"))).isDirectory()).toBe(true);

		// Vault sections scaffolded.
		for (const section of VAULT_SECTION_DIRS) {
			expect((await fs.stat(path.join(registrySource, "vault", section))).isDirectory()).toBe(true);
		}

		// ~/vault symlink resolves (through the link) to the vault location.
		const vaultLink = path.join(home, "vault");
		expect((await fs.lstat(vaultLink)).isSymbolicLink()).toBe(true);
		expect((await fs.stat(vaultLink)).isDirectory()).toBe(true);
		expect((await fs.stat(path.join(vaultLink, "projects"))).isDirectory()).toBe(true);

		// Validation steps confirm both invariants.
		expect(report.steps.find(s => s.id === "validate-vault")?.status).toBe("exists");
		expect(report.steps.find(s => s.id === "validate-registry")?.status).toBe("exists");
	});

	it("registers local model endpoints declared in endpoints.yaml (§9)", async () => {
		await fs.writeFile(
			path.join(registrySource, "endpoints.yaml"),
			YAML.stringify({
				providers: {
					"ollama-local": {
						baseUrl: "http://127.0.0.1:11434/v1",
						api: "openai-completions",
						discovery: { type: "ollama" },
					},
				},
			}),
			"utf8",
		);

		const report = await runEntitySetup(baseOptions());
		expect(report.ok).toBe(true);
		expect(report.steps.find(s => s.id === "endpoint:ollama-local")?.status).toBe("created");

		const models = YAML.parse(await fs.readFile(modelsConfigPath, "utf8")) as {
			providers: Record<string, { baseUrl: string }>;
		};
		expect(models.providers["ollama-local"]?.baseUrl).toBe("http://127.0.0.1:11434/v1");
	});
});

describe("runEntitySetup — embedder warm-cache (§7.1)", () => {
	it("is skipped by default (setup stays filesystem-only)", async () => {
		let called = false;
		const report = await runEntitySetup({
			...baseOptions(),
			warmCacheRunner: async () => {
				called = true;
				return { ok: true, detail: "warmed" };
			},
		});
		expect(called).toBe(false);
		expect(report.steps.find(s => s.id === "warm-cache")?.status).toBe("skipped");
	});

	it("runs the warm-cache runner against the vault location when --warm-cache is set", async () => {
		let seen: string | undefined;
		const report = await runEntitySetup({
			...baseOptions(),
			warmCache: true,
			warmCacheRunner: async loc => {
				seen = loc;
				return { ok: true, detail: "embedder warmed" };
			},
		});
		expect(seen).toBe(path.resolve(path.join(registrySource, "vault")));
		expect(report.steps.find(s => s.id === "warm-cache")?.status).toBe("created");
		expect(report.ok).toBe(true);
	});

	it("a warm-cache failure never fails setup (best-effort)", async () => {
		const report = await runEntitySetup({
			...baseOptions(),
			warmCache: true,
			warmCacheRunner: async () => {
				throw new Error("offline");
			},
		});
		expect(report.steps.find(s => s.id === "warm-cache")?.status).toBe("skipped");
		expect(report.ok).toBe(true);
	});
});

describe("runEntitySetup — re-run is a no-op", () => {
	it("reports everything as exists on the second run (no created/updated)", async () => {
		await fs.writeFile(
			path.join(registrySource, "endpoints.yaml"),
			YAML.stringify({
				providers: { "lm-studio": { baseUrl: "http://127.0.0.1:1234/v1", api: "openai-completions" } },
			}),
			"utf8",
		);
		await runEntitySetup(baseOptions());
		const second = await runEntitySetup(baseOptions());

		expect(second.ok).toBe(true);
		const created = second.steps.filter(s => s.status === "created" || s.status === "updated");
		expect(created).toEqual([]);
		expect(second.steps.find(s => s.id === "vault-symlink")?.status).toBe("exists");
		expect(second.steps.find(s => s.id === "registry-root")?.status).toBe("exists");
		expect(second.steps.find(s => s.id === "endpoint:lm-studio")?.status).toBe("exists");
	});

	it("preserves existing files and adds only missing ones (no clobber)", async () => {
		// Pre-seed a record and models.yml the setup must not touch.
		await fs.mkdir(path.join(registrySource, "entities"), { recursive: true });
		const record = path.join(registrySource, "entities", "keep.md");
		await fs.writeFile(record, "sentinel", "utf8");
		await fs.writeFile(
			modelsConfigPath,
			YAML.stringify({ providers: { anthropic: { baseUrl: "https://api.anthropic.com" } } }),
			"utf8",
		);
		await fs.writeFile(
			path.join(registrySource, "endpoints.yaml"),
			YAML.stringify({ providers: { vllm: { baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions" } } }),
			"utf8",
		);

		await runEntitySetup(baseOptions());

		// Pre-existing record untouched.
		expect(await fs.readFile(record, "utf8")).toBe("sentinel");
		// Existing provider preserved, new one added.
		const models = YAML.parse(await fs.readFile(modelsConfigPath, "utf8")) as { providers: Record<string, unknown> };
		expect(models.providers.anthropic).toBeDefined();
		expect(models.providers.vllm).toBeDefined();
	});
});

describe("runEntitySetup — conflicts", () => {
	it("reports a conflict when ~/vault points elsewhere, and relinks with force", async () => {
		const elsewhere = path.join(root, "other-vault");
		await fs.mkdir(elsewhere, { recursive: true });
		await fs.symlink(elsewhere, path.join(home, "vault"));

		const conflicted = await runEntitySetup(baseOptions());
		expect(conflicted.ok).toBe(false);
		expect(conflicted.steps.find(s => s.id === "vault-symlink")?.status).toBe("conflict");

		const forced = await runEntitySetup({ ...baseOptions(), force: true });
		expect(forced.steps.find(s => s.id === "vault-symlink")?.status).toBe("updated");
		const target = await fs.readlink(path.join(home, "vault"));
		expect(path.resolve(target)).toBe(path.resolve(path.join(registrySource, "vault")));
	});

	it("never deletes a real directory occupying the ~/vault path", async () => {
		const realDir = path.join(home, "vault");
		await fs.mkdir(realDir, { recursive: true });
		await fs.writeFile(path.join(realDir, "important.md"), "user data", "utf8");

		const report = await runEntitySetup({ ...baseOptions(), force: true });
		expect(report.steps.find(s => s.id === "vault-symlink")?.status).toBe("conflict");
		// User data survives even with --force.
		expect((await fs.lstat(realDir)).isDirectory()).toBe(true);
		expect(await fs.readFile(path.join(realDir, "important.md"), "utf8")).toBe("user data");
	});
});

describe("runEntitySetup — registry domains (ADR 0004)", () => {
	it("writes a valid multi-registry manifest and is a no-op on re-run", async () => {
		const manifestPath = path.join(root, "registries.json");
		const omaRoot = path.join(root, "oma-reg");
		const secretRoot = path.join(root, "secret-reg");
		const opts = {
			homeDir: home,
			agentDir,
			registrySource: omaRoot,
			manifestPath,
			registries: [
				{ id: "oma", root: omaRoot, visibility: "public" as const },
				{ id: "secret", root: secretRoot, visibility: "private" as const },
			],
		};

		const first = await runEntitySetup(opts);
		expect(first.ok).toBe(true);
		expect(first.manifestPath).toBe(path.resolve(manifestPath));
		expect(first.steps.find(s => s.id === "registries-manifest")?.status).toBe("created");

		const written = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<
			string,
			{ visibility: string; root: string }
		>;
		expect(Object.keys(written).sort()).toEqual(["oma", "secret"]);
		expect(written.secret.visibility).toBe("private");

		const second = await runEntitySetup(opts);
		expect(second.ok).toBe(true);
		expect(second.steps.filter(s => s.status === "created" || s.status === "updated")).toEqual([]);
		expect(second.steps.find(s => s.id === "registries-manifest")?.status).toBe("exists");
	});

	it("refuses to clobber a conflicting existing manifest", async () => {
		const manifestPath = path.join(root, "registries.json");
		const existing = JSON.stringify({ oma: { root: path.join(root, "other"), visibility: "public" } });
		await fs.writeFile(manifestPath, existing, "utf8");

		const report = await runEntitySetup({
			homeDir: home,
			agentDir,
			registrySource,
			manifestPath,
			registries: [{ id: "oma", root: path.join(root, "oma-reg"), visibility: "public" as const }],
		});
		expect(report.ok).toBe(false);
		expect(report.steps.find(s => s.id === "registries-manifest")?.status).toBe("conflict");
		// The existing manifest is left byte-for-byte intact.
		expect(await fs.readFile(manifestPath, "utf8")).toBe(existing);
	});

	it("scaffolds per-registry symlinks, entities/sections, and a .smart-env gitignore", async () => {
		const manifestPath = path.join(root, "registries.json");
		const omaRoot = path.join(root, "oma-reg");
		const secretRoot = path.join(root, "secret-reg");
		const report = await runEntitySetup({
			homeDir: home,
			agentDir,
			registrySource: omaRoot,
			manifestPath,
			registries: [
				{ id: "oma", root: omaRoot, visibility: "public" as const },
				{ id: "secret", root: secretRoot, visibility: "private" as const },
			],
		});
		expect(report.ok).toBe(true);

		for (const [id, regRoot] of [
			["oma", omaRoot],
			["secret", secretRoot],
		] as const) {
			const link = path.join(home, `${id}-registry`);
			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
			expect(path.resolve(await fs.readlink(link))).toBe(path.resolve(regRoot));
			expect((await fs.stat(path.join(regRoot, "entities"))).isDirectory()).toBe(true);
			for (const section of [...VAULT_SECTION_DIRS, "reference"]) {
				expect((await fs.stat(path.join(regRoot, section))).isDirectory()).toBe(true);
			}
			expect(await fs.readFile(path.join(regRoot, ".gitignore"), "utf8")).toContain(".smart-env/");
		}
	});

	it("migrates a legacy ~/vault into ~/oma-registry idempotently", async () => {
		const manifestPath = path.join(root, "registries.json");
		const registryRoot = path.join(root, "reg");
		const legacyVault = path.join(root, "legacy-vault");
		await fs.mkdir(legacyVault, { recursive: true });
		await fs.symlink(legacyVault, path.join(home, "vault"));
		const opts = { homeDir: home, agentDir, manifestPath, registryRoot, vaultLocation: legacyVault };

		const first = await runEntitySetup(opts);
		expect(first.steps.find(s => s.id === "legacy-vault-migration")?.status).toBe("created");
		expect(first.registries.find(r => r.id === "oma")?.root).toBe(path.resolve(legacyVault));
		const omaLink = path.join(home, "oma-registry");
		expect(path.resolve(await fs.readlink(omaLink))).toBe(path.resolve(legacyVault));

		const second = await runEntitySetup(opts);
		expect(second.steps.find(s => s.id === "legacy-vault-migration")?.status).toBe("exists");
		expect(path.resolve(await fs.readlink(omaLink))).toBe(path.resolve(legacyVault));
		expect(second.steps.filter(s => s.status === "created" || s.status === "updated")).toEqual([]);
	});

	it("rewrites supplied @~/vault/ project-pointer stubs to @~/oma-registry/", async () => {
		const stub = path.join(root, "phi.project.md");
		await fs.writeFile(stub, "see @~/vault/projects/phi.md plus @~/vault/reference/x", "utf8");

		const results = await rewriteVaultPointerStubs([stub, path.join(root, "missing.md")]);
		expect(results[0]).toMatchObject({ changed: true, replacements: 2 });
		expect(results[1]).toMatchObject({ changed: false, replacements: 0 });
		expect(await fs.readFile(stub, "utf8")).toBe(
			"see @~/oma-registry/projects/phi.md plus @~/oma-registry/reference/x",
		);
	});

	it("rewrites vault stubs through setup when rewriteVaultStubs is set", async () => {
		const stub = path.join(root, "proj.md");
		await fs.writeFile(stub, "@~/vault/projects/x", "utf8");
		const report = await runEntitySetup({
			homeDir: home,
			agentDir,
			registrySource,
			manifestPath: path.join(root, "registries.json"),
			rewriteVaultStubs: true,
			vaultStubPaths: [stub],
		});
		expect(report.steps.find(s => s.id === `stub-rewrite:${stub}`)?.status).toBe("updated");
		expect(await fs.readFile(stub, "utf8")).toBe("@~/oma-registry/projects/x");
	});
});
