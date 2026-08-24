/**
 * Registry manifest — the set of knowledge **registries** (domains) an entity
 * runtime can see (ADR 0004). A *registry* is one root holding entity records
 * (`entities/`), vault sections (`agents/ personas/ projects/`), and its own
 * Smart Connections index (`.smart-env/`), backed by one git repo.
 *
 * Access is directional (ADR 0004 Q4/Q9–Q12):
 *   - An entity **writes** only its home registry.
 *   - An entity **reads** its home, every `public` registry, plus any `private`
 *     registry that named the entity's home registry in `readableBy`.
 *   - A `public` registry can NEVER read a `private` one — grants only widen
 *     reads *among private registries*, so nothing private routes to a public
 *     repo. This is enforced at manifest load: a reader named in any
 *     `readableBy` must itself be `private`.
 *   - Grants are non-transitive: only the direct edges named here count.
 *
 * When no manifest file exists the loader synthesizes a single default
 * (`public`) registry from the legacy entity-registry root, so pre-ADR-0004
 * single-vault setups keep working with zero configuration.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isEnoent, isRecord } from "@oh-my-pi/pi-utils";

/** A registry's read exposure. `private` is the default isolation posture. */
export type RegistryVisibility = "public" | "private";

/** One registry (domain) as declared in the manifest. */
export interface RegistryEntry {
	/** Stable id, e.g. `oma` | `capitec`. Matches {@link REGISTRY_ID_PATTERN}. */
	id: string;
	/** Absolute registry root: holds `entities/`, vault sections, and `.smart-env/`. */
	root: string;
	visibility: RegistryVisibility;
	/**
	 * Private registries only: ids of the **private** registries granted read
	 * access to THIS registry (target-declared allowlist, ADR 0004 Q10). Empty
	 * for `public` registries.
	 */
	readableBy: string[];
	/** Optional backing repo URL (informational; not used for resolution). */
	repo?: string;
}

/** Parsed manifest: id → entry, plus its provenance for diagnostics. */
export interface RegistryManifest {
	registries: Map<string, RegistryEntry>;
	/** Absolute manifest path, or `<synthesized>` when no file existed. */
	source: string;
}

/** One root in an entity's resolved access set (ADR 0004 Q7 path-jail input). */
export interface RegistryAccess {
	id: string;
	root: string;
	/** Only the home registry is writable; every other readable root is read-only. */
	writable: boolean;
}

/** Env var pointing at the registries manifest JSON. */
export const REGISTRY_MANIFEST_ENV = "OMP_REGISTRIES";

/** Env var for the legacy single entity-registry root (pre-ADR-0004 fallback). */
const LEGACY_REGISTRY_ENV = "OMP_ENTITY_REGISTRY";

/** Manifest filename under the agent dir when neither explicit path nor env is set. */
export const REGISTRY_MANIFEST_FILENAME = "registries.json";

/** Id assigned to the synthesized default registry (the public OMA home). */
export const DEFAULT_REGISTRY_ID = "oma";

/** Filesystem-/id-safe registry id (mirrors the entity-name rule). */
export const REGISTRY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** A malformed or policy-violating registries manifest. */
export class RegistryManifestError extends Error {
	readonly source?: string;
	constructor(message: string, source?: string) {
		super(source ? `${message} (${source})` : message);
		this.name = "RegistryManifestError";
		this.source = source;
	}
}

/** No registry with the requested id exists in the manifest. */
export class RegistryNotFoundError extends Error {
	readonly id: string;
	constructor(id: string, source: string) {
		super(`No registry "${id}" in manifest (${source})`);
		this.name = "RegistryNotFoundError";
		this.id = id;
	}
}

/** Expand a leading `~`/`~/` to the user's home directory. */
function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** Options shared by manifest entry points. */
export interface RegistryManifestOptions {
	/** Explicit manifest path; overrides {@link REGISTRY_MANIFEST_ENV} and the default. */
	manifestPath?: string;
	/**
	 * Root for the synthesized default registry when no manifest file exists.
	 * Defaults to the legacy resolution (`OMP_ENTITY_REGISTRY` → `<agentDir>/registry`).
	 */
	fallbackRoot?: string;
}

/**
 * Resolve the manifest path: explicit option > {@link REGISTRY_MANIFEST_ENV} env
 * > `<agentDir>/registries.json`.
 */
export function getRegistryManifestPath(explicit?: string): string {
	const chosen = explicit?.trim() || process.env[REGISTRY_MANIFEST_ENV]?.trim();
	if (chosen) return path.resolve(expandHome(chosen));
	return path.join(getAgentDir(), REGISTRY_MANIFEST_FILENAME);
}

/** Legacy single-registry root: `OMP_ENTITY_REGISTRY` env, else `<agentDir>/registry`. */
function legacyRegistryRoot(): string {
	const env = process.env[LEGACY_REGISTRY_ENV]?.trim();
	if (env) return path.resolve(expandHome(env));
	return path.join(getAgentDir(), "registry");
}

/** Build the single-registry manifest used when no manifest file is present. */
function synthesizeDefaultManifest(options: RegistryManifestOptions): RegistryManifest {
	const root = options.fallbackRoot?.trim()
		? path.resolve(expandHome(options.fallbackRoot.trim()))
		: legacyRegistryRoot();
	const registries = new Map<string, RegistryEntry>([
		[DEFAULT_REGISTRY_ID, { id: DEFAULT_REGISTRY_ID, root, visibility: "public", readableBy: [] }],
	]);
	return { registries, source: "<synthesized>" };
}

function requireString(value: unknown, field: string, id: string, source: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new RegistryManifestError(`registry "${id}" field "${field}" must be a non-empty string`, source);
	}
	return value.trim();
}

function parseReadableBy(value: unknown, id: string, visibility: RegistryVisibility, source: string): string[] {
	if (value === undefined || value === null) return [];
	if (visibility !== "private") {
		throw new RegistryManifestError(
			`registry "${id}" is public; "readableBy" is only valid on private registries`,
			source,
		);
	}
	if (!Array.isArray(value) || value.some(v => typeof v !== "string")) {
		throw new RegistryManifestError(`registry "${id}" field "readableBy" must be an array of registry ids`, source);
	}
	return (value as string[]).map(v => v.trim()).filter(Boolean);
}

/**
 * Validate + normalize a manifest object (`{ [id]: entry }`) into a
 * {@link RegistryManifest}. Enforces the ADR 0004 Q9 invariant: any registry
 * named in a private registry's `readableBy` must itself be private.
 */
export function parseRegistryManifest(json: unknown, source: string): RegistryManifest {
	if (!isRecord(json)) {
		throw new RegistryManifestError(`manifest must be a JSON object mapping registry id → entry`, source);
	}
	const registries = new Map<string, RegistryEntry>();
	for (const [id, value] of Object.entries(json)) {
		if (!REGISTRY_ID_PATTERN.test(id)) {
			throw new RegistryManifestError(`registry id "${id}" must match ${REGISTRY_ID_PATTERN}`, source);
		}
		if (!isRecord(value)) {
			throw new RegistryManifestError(
				`registry "${id}" must be an object { root, visibility, readableBy?, repo? }`,
				source,
			);
		}
		const visRaw = value.visibility;
		if (visRaw !== "public" && visRaw !== "private") {
			throw new RegistryManifestError(`registry "${id}" field "visibility" must be "public" | "private"`, source);
		}
		const visibility = visRaw as RegistryVisibility; // validated by the guard above
		const root = path.resolve(expandHome(requireString(value.root, "root", id, source)));
		const readableBy = parseReadableBy(value.readableBy, id, visibility, source);
		const repo = value.repo === undefined ? undefined : requireString(value.repo, "repo", id, source);
		registries.set(id, { id, root, visibility, readableBy, repo });
	}
	if (registries.size === 0) {
		throw new RegistryManifestError(`manifest defines no registries`, source);
	}
	// ADR 0004 Q9/Q11: every reader granted access to a private registry must
	// itself exist and be private; a registry cannot grant to itself.
	for (const entry of registries.values()) {
		for (const readerId of entry.readableBy) {
			if (readerId === entry.id) {
				throw new RegistryManifestError(`registry "${entry.id}" cannot list itself in "readableBy"`, source);
			}
			const reader = registries.get(readerId);
			if (!reader) {
				throw new RegistryManifestError(
					`registry "${entry.id}" readableBy names unknown registry "${readerId}"`,
					source,
				);
			}
			if (reader.visibility !== "private") {
				throw new RegistryManifestError(
					`registry "${entry.id}" readableBy names "${readerId}", which is public — a public registry can never read a private one (ADR 0004 Q9)`,
					source,
				);
			}
		}
	}
	return { registries, source };
}

/**
 * Load the registries manifest: explicit path > env > `<agentDir>/registries.json`.
 * Missing file → a synthesized single default (`public`) registry so legacy
 * setups keep working. Throws {@link RegistryManifestError} on a malformed file.
 */
export async function loadRegistryManifest(options: RegistryManifestOptions = {}): Promise<RegistryManifest> {
	const manifestPath = getRegistryManifestPath(options.manifestPath);
	let raw: string;
	try {
		raw = await fs.readFile(manifestPath, "utf-8");
	} catch (err) {
		if (isEnoent(err)) return synthesizeDefaultManifest(options);
		throw err;
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		throw new RegistryManifestError(`registries manifest is not valid JSON`, manifestPath);
	}
	return parseRegistryManifest(json, manifestPath);
}

/** Look up one registry by id; throws {@link RegistryNotFoundError} if absent. */
export function getRegistry(manifest: RegistryManifest, id: string): RegistryEntry {
	const entry = manifest.registries.get(id);
	if (!entry) throw new RegistryNotFoundError(id, manifest.source);
	return entry;
}

/**
 * Resolve the ordered access set for an entity whose home registry is `homeId`
 * (ADR 0004): the home root (writable) followed by every readable root — each
 * `public` registry and each `private` registry that named `homeId` in its
 * `readableBy`. Read-only order is deterministic (public first, then granted
 * private), both sorted by id. Throws if `homeId` is unknown.
 */
export function resolveRegistryAccess(manifest: RegistryManifest, homeId: string): RegistryAccess[] {
	const home = getRegistry(manifest, homeId);
	const readable: RegistryAccess[] = [];
	const granted: RegistryAccess[] = [];
	for (const entry of manifest.registries.values()) {
		if (entry.id === homeId) continue;
		if (entry.visibility === "public") {
			readable.push({ id: entry.id, root: entry.root, writable: false });
		} else if (entry.readableBy.includes(homeId)) {
			granted.push({ id: entry.id, root: entry.root, writable: false });
		}
	}
	const byId = (a: RegistryAccess, b: RegistryAccess) => a.id.localeCompare(b.id);
	readable.sort(byId);
	granted.sort(byId);
	return [{ id: home.id, root: home.root, writable: true }, ...readable, ...granted];
}

/** The ids visible to an entity homed at `homeId`: home ∪ readable set (Q12). */
export function visibleRegistryIds(manifest: RegistryManifest, homeId: string): string[] {
	return resolveRegistryAccess(manifest, homeId).map(a => a.id);
}
