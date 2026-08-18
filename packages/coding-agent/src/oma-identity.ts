/**
 * Identity for the Persistent Agents build (`oma`), kept distinct from stock
 * `omp`. Consumed by the `oma` bin shim (`oma.ts`) and passed into `runCli` so
 * `--version`, `--help`, and usage lines render the `oma` name and its own
 * version — never the upstream `omp` label/number this fork rides on.
 *
 * Imports nothing: safe to load from the shim before `PI_CONFIG_DIR` is applied
 * and before any pi-utils path resolution.
 */

/** CLI name shown by `oma --version`/`--help` and usage lines. */
export const OMA_APP_NAME = "oma";

/**
 * OMA's own version, independent of the upstream `omp` `VERSION` (dirs.ts) this
 * build forks. Bump on each OMA release; unrelated to omp's numbering so an
 * `oma/x.y.z` line is never mistaken for an upstream omp version.
 */
export const OMA_VERSION = "0.1.0";

/**
 * Environment marker the `oma.ts` shim sets so code far from the entry (e.g. the
 * status-line brand segment) can tell it is running under the OMA build without
 * threading identity through every call. Inherited by worker subprocesses.
 */
export const OMA_BUILD_ENV = "OMA_BUILD";

/** True when running as the OMA build (marker set by the `oma.ts` shim). */
export function isOmaBuild(): boolean {
	return process.env[OMA_BUILD_ENV] === "1";
}
