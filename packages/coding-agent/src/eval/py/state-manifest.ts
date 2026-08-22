/**
 * Post-compaction live-state manifest for the persistent Python kernel.
 *
 * The `eval` Python kernel is a subprocess whose `user_ns` (variables, imports,
 * user-defined functions) survives across cells, across a compaction event, and
 * across client detach/reattach of a resident worker — its lifetime is bound to
 * the owning {@link AgentSession}, never to the model's context window (see
 * `eval/py/executor.ts` session registry + `session/eval-runner.ts` owner
 * disposal). Compaction rewrites the transcript the model reads, so the model
 * can lose track of state it deliberately stashed in the kernel while the kernel
 * still holds it — the "compaction trap".
 *
 * This module closes that gap on the awareness side: given a live kernel, it
 * introspects `user_ns` and returns a compact manifest (name + type + short
 * repr) suitable for re-injection into context right after a compaction
 * completes, so the model does not orphan live kernel state.
 */

/** Minimal live-kernel handle: anything that can run a cell and hand back stdout. */
export interface ManifestKernel {
	execute(code: string): Promise<{ output: string }>;
}

/** One live user-namespace binding surfaced in the manifest. */
export interface LiveVariable {
	name: string;
	/** `type(value).__name__` */
	type: string;
	/** Truncated `repr(value)`. */
	repr: string;
	/** `len(value)` when the value is sized (containers/strings); omitted otherwise. */
	size?: number;
}

export interface StateManifestOptions {
	/** Max variables listed before the manifest summarizes the remainder. Default 40. */
	maxVars?: number;
	/** Max characters kept from each `repr` before elision. Default 120. */
	maxReprLen?: number;
	/**
	 * Names to treat as prelude/injected (excluded from the manifest). Defaults
	 * to {@link PRELUDE_BASELINE}. Production callers SHOULD pass the snapshot
	 * `frozenset(user_ns)` taken at kernel init so the exclusion self-updates.
	 */
	baseline?: readonly string[];
}

const DEFAULT_MAX_VARS = 40;
const DEFAULT_MAX_REPR_LEN = 120;

const SENTINEL_BEGIN = "<<<OMP_STATE_MANIFEST_BEGIN>>>";
const SENTINEL_END = "<<<OMP_STATE_MANIFEST_END>>>";

/**
 * Names the compiled-in prelude plants into `user_ns` at kernel start (public
 * helpers plus the prelude's own module-level imports/constants — see
 * `eval/py/prelude.py` + `runner.py::_install_builtins`). Captured empirically
 * from a pristine kernel; deterministic per prelude version. Manifest treats
 * everything else non-`_`-prefixed and non-module as user state.
 *
 * NOTE (production hook): rather than hardcoding this list, the resident worker
 * should snapshot `frozenset(user_ns)` once at kernel init and pass it here, so
 * the exclusion tracks prelude changes automatically. Hardcoding keeps this
 * prototype self-contained.
 */
const PRELUDE_BASELINE = [
	"INTENT_FIELD",
	"Path",
	"agent",
	"annotations",
	"budget",
	"completion",
	"display",
	"env",
	"json",
	"log",
	"math",
	"os",
	"output",
	"parallel",
	"phase",
	"pipeline",
	"re",
	"read",
	"sys",
	"tool",
	"unquote",
	"urllib",
	"write",
];

function buildIntrospectionCode(maxReprLen: number, baseline: readonly string[]): string {
	const injected = JSON.stringify(baseline);
	// Runs entirely inside a function so no binding leaks into `user_ns`, and
	// emits exactly one sentinel-wrapped JSON line so host parsing is trivial.
	return [
		"def __omp_state_manifest__():",
		"    import json as _json, types as _types, builtins as _b",
		`    _skip = set(${injected})`,
		`    _cap = ${maxReprLen}`,
		"    _ns = globals()",
		"    _rows = []",
		"    for _name in sorted(_ns):",
		"        if _name.startswith('_'):",
		"            continue",
		"        if _name in _skip:",
		"            continue",
		"        _v = _ns[_name]",
		"        if isinstance(_v, _types.ModuleType):",
		"            continue",
		"        try:",
		"            _r = repr(_v)",
		"        except Exception as _e:",
		"            _r = '<repr failed: %s>' % type(_e).__name__",
		"        if len(_r) > _cap:",
		"            _r = _r[:_cap] + '…'",
		"        _row = {'name': _name, 'type': type(_v).__name__, 'repr': _r}",
		"        try:",
		"            if not isinstance(_v, (str, bytes)) or True:",
		"                _row['size'] = len(_v)",
		"        except Exception:",
		"            pass",
		"        _rows.append(_row)",
		`    print('${SENTINEL_BEGIN}' + _json.dumps(_rows) + '${SENTINEL_END}')`,
		"__omp_state_manifest__()",
		"del __omp_state_manifest__",
	].join("\n");
}

function parseManifestOutput(output: string): LiveVariable[] {
	const begin = output.indexOf(SENTINEL_BEGIN);
	const end = output.indexOf(SENTINEL_END);
	if (begin < 0 || end < 0 || end < begin) return [];
	const json = output.slice(begin + SENTINEL_BEGIN.length, end);
	try {
		const parsed = JSON.parse(json) as LiveVariable[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** Introspect a live kernel and return its user-defined bindings. */
export async function collectLiveVariables(
	kernel: ManifestKernel,
	options?: StateManifestOptions,
): Promise<LiveVariable[]> {
	const maxReprLen = options?.maxReprLen ?? DEFAULT_MAX_REPR_LEN;
	const baseline = options?.baseline ?? PRELUDE_BASELINE;
	const { output } = await kernel.execute(buildIntrospectionCode(maxReprLen, baseline));
	return parseManifestOutput(output);
}

/** Render collected variables into a compact, context-injectable manifest string. */
export function renderStateManifest(vars: LiveVariable[], options?: StateManifestOptions): string {
	if (vars.length === 0) return "";
	const maxVars = options?.maxVars ?? DEFAULT_MAX_VARS;
	const shown = vars.slice(0, maxVars);
	const lines = shown.map(v => {
		const sizePart = v.size === undefined ? "" : ` len=${v.size}`;
		return `- ${v.name}: ${v.type}${sizePart} = ${v.repr}`;
	});
	const header =
		`Live Python kernel state survived compaction — ${vars.length} ` +
		`variable${vars.length === 1 ? "" : "s"} still held in the kernel ` +
		`(re-use directly via eval; do not recompute):`;
	const overflow = vars.length > shown.length ? [`- … and ${vars.length - shown.length} more`] : [];
	return [header, ...lines, ...overflow].join("\n");
}

/**
 * Convenience: introspect a live kernel and return the ready-to-inject manifest
 * string. Empty string when the kernel holds no user state (nothing to inject).
 */
export async function buildStateManifest(kernel: ManifestKernel, options?: StateManifestOptions): Promise<string> {
	const vars = await collectLiveVariables(kernel, options);
	return renderStateManifest(vars, options);
}
