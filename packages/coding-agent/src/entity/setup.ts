/**
 * WS7a — persistent multi-entity setup / bootstrap (SPEC §12.7a, §7.3,
 * resolved-item 4).
 *
 * First-run, idempotent, re-runnable bootstrap for the persistent multi-entity
 * runtime. One `runEntitySetup()` on a fresh machine yields:
 *   1. a scaffolded repo-2 registry layout (`<root>/entities`);
 *   2. the entity-registry root wired to that layout (a `<agentDir>/registry`
 *      symlink to a checkout, or the resolved default in place);
 *   3. a resolvable `~/vault` symlink pointing at the actual vault location,
 *      with the `agents/`, `personas/`, `projects/` sections scaffolded (§7);
 *   4. any configured local model endpoints registered as OMP providers (§9).
 *
 * Re-running is a NO-OP, never a clobber: existing dirs are left alone, a
 * symlink that already points at the intended target is reported `exists`, a
 * symlink pointing elsewhere or a real file/dir occupying a link path is a
 * reported conflict (only replaced when `force` is set, and never for a real
 * non-symlink directory holding user data).
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { ENTITY_RECORDS_SUBDIR, ENTITY_REGISTRY_ENV, getEntityRegistryRoot } from "./loader";
import { isDevCheckout, vaultServerModulePath } from "./mcp-wiring";
import {
	DEFAULT_REGISTRY_ID,
	getRegistryManifestPath,
	parseRegistryManifest,
	REGISTRY_MANIFEST_ENV,
	REGISTRY_MANIFEST_FILENAME,
	type RegistryManifest,
	type RegistryVisibility,
} from "./registries";

/** Vault section subdirectories (SPEC §4.3, §7). */
export const VAULT_SECTION_DIRS = ["agents", "personas", "projects"] as const;

/** Default filename (under the registry root) declaring local model endpoints (§9). */
export const ENDPOINTS_FILENAME = "endpoints.yaml";

/**
 * One registry (domain) to establish: its id, root, read exposure, and optional
 * `readableBy` (private only) / `repo`. The manifest is generated from these
 * (ADR 0004 Q3/Q5).
 */
export interface RegistryDefinition {
	id: string;
	root: string;
	visibility: RegistryVisibility;
	readableBy?: string[];
	repo?: string;
}

/** Outcome of a single idempotent setup action. */
export type SetupStepStatus = "created" | "exists" | "updated" | "skipped" | "conflict";

export interface SetupStep {
	/** Stable step id (e.g. `registry-root`, `vault-symlink`, `endpoint:ollama`). */
	id: string;
	status: SetupStepStatus;
	/** Human-readable detail (path created, conflict reason, …). */
	detail: string;
	/** Absolute path this step acted on, when applicable. */
	path?: string;
}

export interface SetupReport {
	/** Resolved registry root (records + vault live here). */
	registryRoot: string;
	/** Resolved actual vault location (target of the `~/vault` symlink). */
	vaultLocation: string;
	/** Resolved `~/vault` symlink path. */
	vaultLink: string;
	/** Every action taken, in order. */
	steps: SetupStep[];
	/** True when no step reported a conflict. */
	ok: boolean;
	/** Resolved registries-manifest path that was written/validated. */
	manifestPath: string;
	/** The registry set established (resolved roots), in definition order. */
	registries: Array<{ id: string; root: string; visibility: RegistryVisibility }>;
}

export interface EntitySetupOptions {
	/**
	 * Path to a repo-2 registry checkout to wire the default registry root to.
	 * When set, setup creates `<agentDir>/registry → <registrySource>` and uses
	 * the checkout as the registry root. Mutually exclusive intent with
	 * `registryRoot` (which pins the root directly without a symlink).
	 */
	registrySource?: string;
	/**
	 * Explicit registry root override. When set, records/vault scaffold here and
	 * no `<agentDir>/registry` symlink is created (the caller owns wiring via
	 * `OMP_ENTITY_REGISTRY`). Defaults to the loader's resolved root.
	 */
	registryRoot?: string;
	/**
	 * Actual vault location the `~/vault` symlink points at. Defaults to
	 * `<registryRoot>/vault` (SPEC resolved-item 1: vault starts inside repo 2).
	 */
	vaultLocation?: string;
	/** Register endpoints declared in `<registryRoot>/endpoints.yaml` (§9). Default true. */
	registerEndpoints?: boolean;
	/** Replace a conflicting symlink / overwrite a differing endpoint. Never deletes a real dir. */
	force?: boolean;
	/**
	 * Prefetch the vault's Smart Connections embedding model so the first vault
	 * search has no cold-cache network call (SPEC §7.1). Off by default — setup
	 * is otherwise filesystem-only + offline; this is the one network step, run
	 * via WS4's `omp-vault-mcp --warm-cache`. Best-effort: a failure is reported
	 * but does not fail setup.
	 */
	warmCache?: boolean;
	// --- Injection seams (tests) ------------------------------------------
	/** Home directory root for `~/vault`. Defaults to `os.homedir()`. */
	homeDir?: string;
	/** Agent config dir. Defaults to `getAgentDir()`. */
	agentDir?: string;
	/** OMP models config path. Defaults to `<agentDir>/models.yml`. */
	modelsConfigPath?: string;
	/**
	 * Runs the vault embedder warm-cache for `warmCache`. Defaults to spawning
	 * `omp-vault-mcp --warm-cache --vault <vaultLocation>` (or the dev module).
	 * Injected in tests to avoid a real model download.
	 */
	warmCacheRunner?: (vaultLocation: string) => Promise<{ ok: boolean; detail: string }>;
	/**
	 * Registries (domains) to establish. Default (none supplied): a single public
	 * `oma` registry at the resolved registry root — fully back-compat. Each is
	 * scaffolded (`entities/` + vault sections + `.smart-env` gitignore) and a
	 * `~/<id>-registry` symlink is created.
	 */
	registries?: RegistryDefinition[];
	/**
	 * Where to write/validate the registries manifest. Default: explicit option >
	 * `OMP_REGISTRIES` env > `<agentDir>/registries.json`.
	 */
	manifestPath?: string;
	/**
	 * Rewrite the supplied project-pointer stubs `@~/vault/…` → `@~/oma-registry/…`
	 * (ADR 0004 migration). Off by default; the caller supplies the exact paths in
	 * `vaultStubPaths` (setup never crawls the filesystem).
	 */
	rewriteVaultStubs?: boolean;
	/** Stub files to rewrite when `rewriteVaultStubs` is set. */
	vaultStubPaths?: string[];
	/**
	 * Remove the legacy `~/vault` symlink instead of creating/validating it. Only
	 * ever unlinks a symlink; a real directory is left intact. Default off.
	 */
	dropLegacyVaultSymlink?: boolean;
}

/** A providers map as stored in `models.yml` and `endpoints.yaml`. */
interface EndpointsFile {
	providers?: Record<string, Record<string, unknown>>;
}

async function ensureDir(dir: string, id: string, steps: SetupStep[]): Promise<void> {
	let existed = false;
	try {
		existed = (await fs.stat(dir)).isDirectory();
	} catch (error) {
		if (!isEnoent(error)) {
			steps.push({ id, status: "conflict", detail: `stat failed: ${String(error)}`, path: dir });
			return;
		}
	}
	try {
		await fs.mkdir(dir, { recursive: true });
		steps.push({
			id,
			status: existed ? "exists" : "created",
			detail: existed ? "directory present" : "created directory",
			path: dir,
		});
	} catch (error) {
		steps.push({ id, status: "conflict", detail: `mkdir failed: ${String(error)}`, path: dir });
	}
}

/**
 * Idempotently ensure `linkPath` is a symlink pointing at `target`.
 * - absent → create it (`created`);
 * - already a symlink to `target` → `exists`;
 * - a symlink elsewhere → `updated` when `force`, else `conflict`;
 * - a real file/dir → `conflict` (never destroyed, even with `force`).
 */
async function ensureSymlink(
	linkPath: string,
	target: string,
	id: string,
	steps: SetupStep[],
	force: boolean,
): Promise<void> {
	const absTarget = path.resolve(target);
	let stat: Stats | undefined;
	try {
		stat = await fs.lstat(linkPath);
	} catch (error) {
		if (!isEnoent(error)) {
			steps.push({ id, status: "conflict", detail: `lstat failed: ${String(error)}`, path: linkPath });
			return;
		}
	}

	if (stat === undefined) {
		await fs.mkdir(path.dirname(linkPath), { recursive: true });
		await fs.symlink(absTarget, linkPath);
		steps.push({ id, status: "created", detail: `linked → ${absTarget}`, path: linkPath });
		return;
	}

	if (stat.isSymbolicLink()) {
		const current = await fs.readlink(linkPath);
		const resolvedCurrent = path.resolve(path.dirname(linkPath), current);
		if (resolvedCurrent === absTarget) {
			steps.push({ id, status: "exists", detail: `already linked → ${absTarget}`, path: linkPath });
			return;
		}
		if (force) {
			await fs.unlink(linkPath);
			await fs.symlink(absTarget, linkPath);
			steps.push({ id, status: "updated", detail: `re-linked ${resolvedCurrent} → ${absTarget}`, path: linkPath });
			return;
		}
		steps.push({
			id,
			status: "conflict",
			detail: `symlink points at ${resolvedCurrent}, not ${absTarget} (use --force to relink)`,
			path: linkPath,
		});
		return;
	}

	// A real file or directory occupies the link path. Never delete it — that is
	// almost certainly user data. Report the conflict so the operator resolves it.
	steps.push({
		id,
		status: "conflict",
		detail: `a real ${stat.isDirectory() ? "directory" : "file"} exists at this path; move it aside, then re-run`,
		path: linkPath,
	});
}

/**
 * Merge provider entries from `<registryRoot>/endpoints.yaml` into the OMP
 * `models.yml` providers map (§9). Additive + idempotent: a provider absent
 * from `models.yml` is added; one already present with an equal config is
 * `exists`; a present-but-different config is `skipped` unless `force`.
 */
async function registerEndpoints(
	registryRoot: string,
	modelsConfigPath: string,
	steps: SetupStep[],
	force: boolean,
): Promise<void> {
	const endpointsPath = path.join(registryRoot, ENDPOINTS_FILENAME);
	let raw: string;
	try {
		raw = await fs.readFile(endpointsPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			steps.push({ id: "endpoints", status: "skipped", detail: `no ${ENDPOINTS_FILENAME}`, path: endpointsPath });
			return;
		}
		throw error;
	}

	let parsed: EndpointsFile;
	try {
		parsed = (YAML.parse(raw) as EndpointsFile) ?? {};
	} catch (error) {
		steps.push({
			id: "endpoints",
			status: "conflict",
			detail: `invalid YAML: ${String(error)}`,
			path: endpointsPath,
		});
		return;
	}
	const desired = parsed.providers ?? {};
	const desiredIds = Object.keys(desired);
	if (desiredIds.length === 0) {
		steps.push({ id: "endpoints", status: "skipped", detail: "no providers declared", path: endpointsPath });
		return;
	}

	let existing: EndpointsFile = {};
	try {
		existing = (YAML.parse(await fs.readFile(modelsConfigPath, "utf8")) as EndpointsFile) ?? {};
	} catch (error) {
		if (!isEnoent(error)) {
			steps.push({
				id: "endpoints",
				status: "conflict",
				detail: `models.yml unreadable: ${String(error)}`,
				path: modelsConfigPath,
			});
			return;
		}
	}
	const providers = existing.providers ?? {};

	let changed = false;
	for (const id of desiredIds) {
		const want = desired[id]!;
		const have = providers[id];
		if (have === undefined) {
			providers[id] = want;
			changed = true;
			steps.push({ id: `endpoint:${id}`, status: "created", detail: "registered provider", path: modelsConfigPath });
			continue;
		}
		if (JSON.stringify(have) === JSON.stringify(want)) {
			steps.push({
				id: `endpoint:${id}`,
				status: "exists",
				detail: "provider already registered",
				path: modelsConfigPath,
			});
			continue;
		}
		if (force) {
			providers[id] = want;
			changed = true;
			steps.push({
				id: `endpoint:${id}`,
				status: "updated",
				detail: "overwrote provider config",
				path: modelsConfigPath,
			});
		} else {
			steps.push({
				id: `endpoint:${id}`,
				status: "skipped",
				detail: "provider exists with a different config (use --force to overwrite)",
				path: modelsConfigPath,
			});
		}
	}

	if (changed) {
		existing.providers = providers;
		await fs.mkdir(path.dirname(modelsConfigPath), { recursive: true });
		await fs.writeFile(modelsConfigPath, YAML.stringify(existing, null, 2), "utf8");
	}
}

/**
 * Default warm-cache runner: spawn WS4's vault MCP `--warm-cache` against the
 * vault root, prefetching the Smart Connections embedder, then exit. Uses the
 * linked `omp-vault-mcp` bin when compiled, else `bun run <module>`.
 */
async function defaultWarmCacheRunner(vaultLocation: string): Promise<{ ok: boolean; detail: string }> {
	const dev = isDevCheckout();
	const cmd = dev
		? ["bun", "run", vaultServerModulePath(), "--warm-cache", "--vault", vaultLocation]
		: ["omp-vault-mcp", "--warm-cache", "--vault", vaultLocation];
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode === 0) return { ok: true, detail: `embedder cache warmed for ${vaultLocation}` };
	const stderr = (await new Response(proc.stderr).text()).trim();
	return { ok: false, detail: `warm-cache exited ${exitCode}${stderr ? `: ${stderr.slice(0, 200)}` : ""}` };
}

/** Resolve the target an existing symlink/dir at `linkPath` points at, or undefined if absent. */
async function resolveExistingLink(linkPath: string): Promise<string | undefined> {
	let stat: Stats;
	try {
		stat = await fs.lstat(linkPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	if (stat.isSymbolicLink()) {
		return path.resolve(path.dirname(linkPath), await fs.readlink(linkPath));
	}
	return path.resolve(linkPath);
}

/** Ensure `<root>/.gitignore` ignores `entry` (append if missing, never rewrite). */
async function ensureGitignoreEntry(root: string, entry: string, id: string, steps: SetupStep[]): Promise<void> {
	const gitignorePath = path.join(root, ".gitignore");
	let existing: string | undefined;
	try {
		existing = await fs.readFile(gitignorePath, "utf8");
	} catch (error) {
		if (!isEnoent(error)) {
			steps.push({ id, status: "conflict", detail: `read failed: ${String(error)}`, path: gitignorePath });
			return;
		}
	}
	if (existing === undefined) {
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(gitignorePath, `${entry}\n`, "utf8");
		steps.push({ id, status: "created", detail: `ignore ${entry}`, path: gitignorePath });
		return;
	}
	if (existing.split(/\r?\n/).some(line => line.trim() === entry)) {
		steps.push({ id, status: "exists", detail: `${entry} already ignored`, path: gitignorePath });
		return;
	}
	const next = existing.endsWith("\n") ? `${existing}${entry}\n` : `${existing}\n${entry}\n`;
	await fs.writeFile(gitignorePath, next, "utf8");
	steps.push({ id, status: "updated", detail: `appended ${entry}`, path: gitignorePath });
}

/** Deep-compare two manifests by entry (ignores provenance/source). */
function manifestsEqual(a: RegistryManifest, b: RegistryManifest): boolean {
	if (a.registries.size !== b.registries.size) return false;
	for (const [id, ea] of a.registries) {
		const eb = b.registries.get(id);
		if (!eb || ea.root !== eb.root || ea.visibility !== eb.visibility || ea.repo !== eb.repo) return false;
		const ra = [...ea.readableBy].sort();
		const rb = [...eb.readableBy].sort();
		if (ra.length !== rb.length || ra.some((v, i) => v !== rb[i])) return false;
	}
	return true;
}

/**
 * Idempotently write/validate the registries manifest from `defs`. The
 * definitions are run through {@link parseRegistryManifest} so the Q9 guard
 * applies; a differing existing manifest is a reported `conflict` (never
 * clobbered).
 */
async function ensureManifest(manifestPath: string, defs: RegistryDefinition[], steps: SetupStep[]): Promise<void> {
	const desiredObj: Record<string, Record<string, unknown>> = {};
	for (const def of defs) {
		const entry: Record<string, unknown> = { root: def.root, visibility: def.visibility };
		if (def.visibility === "private" && def.readableBy?.length) entry.readableBy = def.readableBy;
		if (def.repo) entry.repo = def.repo;
		desiredObj[def.id] = entry;
	}
	let desired: RegistryManifest;
	try {
		desired = parseRegistryManifest(desiredObj, manifestPath);
	} catch (error) {
		steps.push({
			id: "registries-manifest",
			status: "conflict",
			detail: `invalid definitions: ${String(error)}`,
			path: manifestPath,
		});
		return;
	}

	let raw: string | undefined;
	try {
		raw = await fs.readFile(manifestPath, "utf8");
	} catch (error) {
		if (!isEnoent(error)) {
			steps.push({
				id: "registries-manifest",
				status: "conflict",
				detail: `read failed: ${String(error)}`,
				path: manifestPath,
			});
			return;
		}
	}

	if (raw === undefined) {
		await fs.mkdir(path.dirname(manifestPath), { recursive: true });
		await fs.writeFile(manifestPath, `${JSON.stringify(desiredObj, null, 2)}\n`, "utf8");
		steps.push({
			id: "registries-manifest",
			status: "created",
			detail: `wrote ${defs.length} registr${defs.length === 1 ? "y" : "ies"}`,
			path: manifestPath,
		});
		return;
	}

	let existing: RegistryManifest;
	try {
		existing = parseRegistryManifest(JSON.parse(raw), manifestPath);
	} catch {
		steps.push({
			id: "registries-manifest",
			status: "conflict",
			detail: "existing manifest is malformed; move it aside to regenerate",
			path: manifestPath,
		});
		return;
	}
	steps.push(
		manifestsEqual(existing, desired)
			? { id: "registries-manifest", status: "exists", detail: "manifest matches definitions", path: manifestPath }
			: {
					id: "registries-manifest",
					status: "conflict",
					detail: "existing manifest differs from definitions; not overwriting (move it aside to regenerate)",
					path: manifestPath,
				},
	);
}

/**
 * Scaffold one registry root: `~/<id>-registry` symlink, `entities/`, the vault
 * section dirs (+ `reference`), and a `.gitignore` ignoring `.smart-env/`.
 */
async function scaffoldRegistry(
	homeDir: string,
	def: RegistryDefinition,
	steps: SetupStep[],
	force: boolean,
): Promise<void> {
	const root = path.resolve(def.root);
	await ensureSymlink(path.join(homeDir, `${def.id}-registry`), root, `registry-symlink:${def.id}`, steps, force);
	await ensureDir(root, `registry-dir:${def.id}`, steps);
	await ensureDir(path.join(root, ENTITY_RECORDS_SUBDIR), `registry-entities:${def.id}`, steps);
	for (const section of [...VAULT_SECTION_DIRS, "reference"]) {
		await ensureDir(path.join(root, section), `registry-section:${def.id}:${section}`, steps);
	}
	await ensureGitignoreEntry(root, ".smart-env/", `registry-gitignore:${def.id}`, steps);
}

/** Outcome of rewriting one project-pointer stub. */
export interface VaultStubRewrite {
	path: string;
	/** True when at least one `@~/vault/` pointer was rewritten. */
	changed: boolean;
	replacements: number;
}

/**
 * Rewrite the project-pointer stubs `@~/vault/…` → `@~/<oma>-registry/…` in the
 * given files (ADR 0004 migration). Pure per-file string replacement; the caller
 * supplies the exact paths (setup never crawls the FS). Missing files are skipped.
 */
export async function rewriteVaultPointerStubs(paths: string[]): Promise<VaultStubRewrite[]> {
	const needle = "@~/vault/";
	const replacement = `@~/${DEFAULT_REGISTRY_ID}-registry/`;
	const results: VaultStubRewrite[] = [];
	for (const p of paths) {
		let content: string;
		try {
			content = await fs.readFile(p, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				results.push({ path: p, changed: false, replacements: 0 });
				continue;
			}
			throw error;
		}
		const replacements = content.split(needle).length - 1;
		if (replacements > 0) await fs.writeFile(p, content.replaceAll(needle, replacement), "utf8");
		results.push({ path: p, changed: replacements > 0, replacements });
	}
	return results;
}

/**
 * Run the idempotent multi-entity setup. Safe to re-run: every action is a
 * no-op when already satisfied. Returns a structured report of what happened;
 * `ok` is false when any step reported a conflict.
 */
export async function runEntitySetup(options: EntitySetupOptions = {}): Promise<SetupReport> {
	const agentDir = options.agentDir ?? getAgentDir();
	const homeDir = options.homeDir ?? os.homedir();
	const force = options.force ?? false;
	const steps: SetupStep[] = [];

	// 1. Resolve + wire the registry root.
	let registryRoot: string;
	if (options.registryRoot) {
		registryRoot = path.resolve(options.registryRoot);
	} else if (options.registrySource) {
		registryRoot = path.resolve(options.registrySource);
		// Wire the loader's default location (`<agentDir>/registry`) to the
		// checkout so `OMP_ENTITY_REGISTRY` need not be exported per shell.
		const defaultRoot = path.join(agentDir, "registry");
		if (path.resolve(defaultRoot) !== registryRoot) {
			await ensureSymlink(defaultRoot, registryRoot, "registry-root", steps, force);
		} else {
			steps.push({
				id: "registry-root",
				status: "exists",
				detail: "checkout is the default root",
				path: registryRoot,
			});
		}
	} else {
		registryRoot = getEntityRegistryRoot({ registryRoot: options.registryRoot });
		const usingEnv = process.env[ENTITY_REGISTRY_ENV];
		steps.push({
			id: "registry-root",
			status: "exists",
			detail: usingEnv ? `from ${ENTITY_REGISTRY_ENV}` : "default location",
			path: registryRoot,
		});
	}

	// 1b. Capture legacy-vault migration state BEFORE creating ~/vault or the
	// per-registry symlinks, so a fresh install is never mistaken for a migration.
	const vaultLink = path.join(homeDir, "vault");
	const omaRegistryLink = path.join(homeDir, `${DEFAULT_REGISTRY_ID}-registry`);
	const legacyVaultTarget = await resolveExistingLink(vaultLink);
	const omaRegistryTarget = await resolveExistingLink(omaRegistryLink);

	// 1c. Build the registry definition set. Default (none supplied) = one public
	// `oma` at the resolved root. In default mode the oma root follows an existing
	// ~/oma-registry (stable re-runs), else adopts a pre-existing legacy ~/vault
	// target (migration).
	let omaRoot = registryRoot;
	let migratingLegacyVault = false;
	if (!options.registries) {
		if (omaRegistryTarget) {
			omaRoot = omaRegistryTarget;
		} else if (legacyVaultTarget) {
			omaRoot = legacyVaultTarget;
			migratingLegacyVault = true;
		}
	}
	const registryDefs: RegistryDefinition[] = options.registries ?? [
		{ id: DEFAULT_REGISTRY_ID, root: omaRoot, visibility: "public" },
	];

	// 1d. Write/validate the registries manifest (explicit > OMP_REGISTRIES > agentDir).
	const manifestPath = getRegistryManifestPath(
		options.manifestPath ??
			(process.env[REGISTRY_MANIFEST_ENV] ? undefined : path.join(agentDir, REGISTRY_MANIFEST_FILENAME)),
	);
	await ensureManifest(manifestPath, registryDefs, steps);

	// 2. Scaffold the registry layout (records dir).
	await ensureDir(registryRoot, "registry-dir", steps);
	await ensureDir(path.join(registryRoot, ENTITY_RECORDS_SUBDIR), "registry-entities", steps);

	// 3. Scaffold the vault location + section dirs (§7).
	const vaultLocation = path.resolve(options.vaultLocation ?? path.join(registryRoot, "vault"));
	await ensureDir(vaultLocation, "vault-dir", steps);
	for (const section of VAULT_SECTION_DIRS) {
		await ensureDir(path.join(vaultLocation, section), `vault-section:${section}`, steps);
	}

	// 4. Create/validate (or drop) the legacy `~/vault` symlink (SPEC §7.3).
	if (options.dropLegacyVaultSymlink) {
		if (legacyVaultTarget === undefined) {
			steps.push({ id: "vault-symlink", status: "skipped", detail: "no ~/vault to drop", path: vaultLink });
		} else if ((await fs.lstat(vaultLink)).isSymbolicLink()) {
			await fs.unlink(vaultLink);
			steps.push({
				id: "vault-symlink",
				status: "updated",
				detail: "dropped legacy ~/vault symlink",
				path: vaultLink,
			});
		} else {
			steps.push({
				id: "vault-symlink",
				status: "skipped",
				detail: "~/vault is a real path; left intact",
				path: vaultLink,
			});
		}
	} else {
		await ensureSymlink(vaultLink, vaultLocation, "vault-symlink", steps, force);
	}

	// 5. Register configured local model endpoints (§9).
	if (options.registerEndpoints ?? true) {
		const modelsConfigPath = options.modelsConfigPath ?? path.join(agentDir, "models.yml");
		try {
			await registerEndpoints(registryRoot, modelsConfigPath, steps, force);
		} catch (error) {
			steps.push({ id: "endpoints", status: "conflict", detail: `endpoint registration failed: ${String(error)}` });
		}
	}

	// 5b. Optional: prefetch the vault embedder so the first search is offline (§7.1).
	if (options.warmCache) {
		const runner = options.warmCacheRunner ?? defaultWarmCacheRunner;
		try {
			const result = await runner(vaultLocation);
			steps.push({
				id: "warm-cache",
				status: result.ok ? "created" : "skipped",
				detail: result.detail,
				path: vaultLocation,
			});
		} catch (error) {
			// Best-effort: a warm-cache failure (offline, model unavailable) never fails setup.
			steps.push({
				id: "warm-cache",
				status: "skipped",
				detail: `warm-cache failed: ${String(error)}`,
				path: vaultLocation,
			});
		}
	} else {
		steps.push({
			id: "warm-cache",
			status: "skipped",
			detail: "not requested (pass --warm-cache)",
			path: vaultLocation,
		});
	}

	// 6. Scaffold every registry root + its `~/<id>-registry` symlink (ADR 0004).
	for (const def of registryDefs) await scaffoldRegistry(homeDir, def, steps, force);

	// 6b. Record the legacy `~/vault` → `~/oma-registry` migration (idempotent).
	if (migratingLegacyVault) {
		steps.push({
			id: "legacy-vault-migration",
			status: "created",
			detail: `adopted legacy ~/vault target ${legacyVaultTarget} as the "${DEFAULT_REGISTRY_ID}" registry root`,
			path: omaRegistryLink,
		});
	} else if (legacyVaultTarget !== undefined && omaRegistryTarget !== undefined) {
		steps.push({
			id: "legacy-vault-migration",
			status: "exists",
			detail: "~/oma-registry already established",
			path: omaRegistryLink,
		});
	} else {
		steps.push({
			id: "legacy-vault-migration",
			status: "skipped",
			detail: "no legacy ~/vault to migrate",
			path: vaultLink,
		});
	}

	// 6c. Optional: rewrite supplied project-pointer stubs `@~/vault/…` → `@~/oma-registry/…`.
	if (options.rewriteVaultStubs && options.vaultStubPaths?.length) {
		for (const rewrite of await rewriteVaultPointerStubs(options.vaultStubPaths)) {
			steps.push({
				id: `stub-rewrite:${rewrite.path}`,
				status: rewrite.changed ? "updated" : "skipped",
				detail: rewrite.changed ? `rewrote ${rewrite.replacements} pointer(s)` : "no ~/vault pointers",
				path: rewrite.path,
			});
		}
	}

	// 7. Validate: `~/vault` resolves to a directory (unless intentionally dropped).
	if (!options.dropLegacyVaultSymlink) {
		let vaultResolves = false;
		try {
			vaultResolves = (await fs.stat(vaultLink)).isDirectory(); // follows the symlink
		} catch {
			vaultResolves = false;
		}
		steps.push(
			vaultResolves
				? { id: "validate-vault", status: "exists", detail: "~/vault resolves to a directory", path: vaultLink }
				: {
						id: "validate-vault",
						status: "conflict",
						detail: "~/vault does not resolve to a directory",
						path: vaultLink,
					},
		);
	}
	const entitiesDir = path.join(registryRoot, ENTITY_RECORDS_SUBDIR);
	let registryLoadable = false;
	try {
		await fs.lstat(entitiesDir);
		registryLoadable = true;
	} catch {
		registryLoadable = false;
	}
	steps.push(
		registryLoadable
			? { id: "validate-registry", status: "exists", detail: "registry is loadable", path: entitiesDir }
			: { id: "validate-registry", status: "conflict", detail: "registry entities dir missing", path: entitiesDir },
	);

	const ok = !steps.some(step => step.status === "conflict");
	if (!ok) logger.warn("entity setup completed with conflicts", { steps: steps.filter(s => s.status === "conflict") });
	return {
		registryRoot,
		vaultLocation,
		vaultLink,
		steps,
		ok,
		manifestPath,
		registries: registryDefs.map(def => ({ id: def.id, root: path.resolve(def.root), visibility: def.visibility })),
	};
}
