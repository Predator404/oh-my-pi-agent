/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * Production worker spawner (SPEC §8.1).
 *
 * Spawns one resident-worker subprocess per {@link WorkerSpawnRequest} and hands
 * the supervisor a {@link BrokerSideLink} over a per-worker Unix socket. Each
 * worker gets its own socket path keyed by its one-time token, so an accepted
 * connection is unambiguously that worker — no shared-endpoint routing, and the
 * worker's `auth` frame (token + generation) still flows through for the
 * supervisor to validate.
 */

import { rm } from "node:fs/promises";
import * as net from "node:net";
import { join } from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../../subprocess/worker-client";
import { DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../protocol";
import type { WorkerSpawner, WorkerSpawnRequest } from "./agent-supervisor";
import type { BrokerSideLink, WorkerToBroker } from "./worker-transport";
import {
	AGENT_WORKER_ACTIVE_SESSION_ID_ENV,
	AGENT_WORKER_ARG,
	AGENT_WORKER_CWD_ENV,
	AGENT_WORKER_ENDPOINT_ENV,
	AGENT_WORKER_ENTITY_ENV,
	AGENT_WORKER_GENERATION_ENV,
	AGENT_WORKER_ROLE_ENV,
	AGENT_WORKER_TOKEN_ENV,
	type BrokerToWorker,
	SocketWorkerLink,
} from "./worker-transport";

const WORKER_CONNECT_TIMEOUT_MS = 30_000;

export interface SubprocessWorkerSpawnerOptions {
	runtimeDir: string;
	projectDir: string;
}

export class SubprocessWorkerSpawner implements WorkerSpawner {
	readonly #runtimeDir: string;
	readonly #projectDir: string;
	readonly #children = new Map<string, Subprocess>();

	constructor(options: SubprocessWorkerSpawnerOptions) {
		this.#runtimeDir = options.runtimeDir;
		this.#projectDir = options.projectDir;
	}

	async spawn(request: WorkerSpawnRequest): Promise<{ link: BrokerSideLink }> {
		const socketPath = join(this.#runtimeDir, `worker-${request.token}.sock`);
		if (process.platform !== "win32") await rm(socketPath, { force: true });

		const connected = Promise.withResolvers<{ link: BrokerSideLink }>();
		const server = net.createServer(socket => {
			server.close();
			connected.resolve({ link: new SocketWorkerLink<BrokerToWorker, WorkerToBroker>(socket) });
		});
		server.on("error", error => connected.reject(error));
		const listening = Promise.withResolvers<void>();
		server.once("listening", () => listening.resolve());
		server.once("error", error => listening.reject(error));
		server.listen(socketPath);
		await listening.promise;

		const { cmd, cwd } = resolveWorkerSpawnCmd(AGENT_WORKER_ARG);
		const env = workerEnvFromParent({
			[AGENT_WORKER_ROLE_ENV]: "1",
			[AGENT_WORKER_TOKEN_ENV]: request.token,
			[AGENT_WORKER_GENERATION_ENV]: request.generation,
			[AGENT_WORKER_ENTITY_ENV]: request.entityName,
			[AGENT_WORKER_ACTIVE_SESSION_ID_ENV]: request.activeSessionId,
			[AGENT_WORKER_CWD_ENV]: request.cwd,
			[AGENT_WORKER_ENDPOINT_ENV]: socketPath,
			[DAEMON_PROJECT_DIR_ENV]: this.#projectDir,
			[DAEMON_RUNTIME_DIR_ENV]: this.#runtimeDir,
		});
		const child = Bun.spawn({ cmd, cwd, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
		this.#children.set(request.activeSessionId, child);
		void child.exited.then(() => this.#children.delete(request.activeSessionId));

		const timeout = setTimeout(
			() => connected.reject(new Error("worker did not connect in time")),
			WORKER_CONNECT_TIMEOUT_MS,
		);
		try {
			return await connected.promise;
		} catch (error) {
			try {
				child.kill();
			} catch {
				// child may already be gone
			}
			server.close();
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	/** Hard-stop every spawned worker. Called on broker shutdown as a backstop. */
	killAll(): void {
		for (const child of this.#children.values()) {
			try {
				child.kill();
			} catch (error) {
				logger.debug("worker kill failed", { error: error instanceof Error ? error.message : String(error) });
			}
		}
		this.#children.clear();
	}
}
