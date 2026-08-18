#!/usr/bin/env bun
/**
 * `oma` bin shim — Oh My Pi, Persistent Agents build.
 *
 * Isolates this build's entire config/runtime root from a stock `omp` install
 * by defaulting `PI_CONFIG_DIR` to `.oma` (stock resolves `.omp`). The daemon
 * broker's runtime directory is `<configRoot>/run/daemons/<hash(projectDir)>`
 * and the socket is keyed on that path, so a differing config root gives `oma`
 * and `omp` disjoint broker sockets — plus disjoint sessions, mnemopi banks,
 * and auth. Without this, the two builds share one per-project broker socket
 * (first process wins, the other adopts it) and the additive daemon protocol
 * added by this build breaks whichever side did not spawn the broker.
 *
 * Set here in the entry module rather than the external launcher so the dev
 * build (`bun src/oma.ts`) and a compiled `oma` binary behave identically: a
 * compiled binary bypasses the launcher entirely. Applied before `./cli.ts` is
 * imported so pi-utils path resolution — and every worker re-entry, which
 * re-runs this entry via `Bun.main` and also inherits this process env — sees
 * the isolated root. `??=` respects an explicit override, so
 * `PI_CONFIG_DIR=… oma` still wins.
 *
 * `cli.ts` gates its own auto-run and worker-host declaration on being the
 * entry module; since it is imported here (not the entry), this shim invokes
 * `runCli` directly with `isProcessEntry: true`. Floating call rather than
 * top-level await mirrors `cli.ts` (TLA forces `--bytecode` builds to fail).
 */
import { OMA_APP_NAME, OMA_BUILD_ENV, OMA_VERSION } from "./oma-identity";

process.env.PI_CONFIG_DIR ??= ".oma";
process.env[OMA_BUILD_ENV] = "1";

import("./cli")
	.then(({ runCli }) =>
		runCli(process.argv.slice(2), { isProcessEntry: true, appName: OMA_APP_NAME, version: OMA_VERSION }),
	)
	.catch((err: unknown) => {
		process.stderr.write(`${Bun.inspect(err, { colors: process.stderr.isTTY === true })}\n`);
		process.exit(1);
	});
