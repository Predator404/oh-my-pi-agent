/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * C5 — Session ownership lease (SPEC §8, CONTRACTS.md C5).
 *
 * Atomic, crash-safe file lease guaranteeing that at most one resident worker
 * owns a given session JSONL at a time. Adapted from Prime `core/session-lease.ts`;
 * the `proper-lockfile` dependency is dropped in favor of an atomic-`mkdir`
 * guard (OMP does not ship proper-lockfile). Lease directory lives under
 * `~/.omp/agent/session-leases/<sha256(sessionPath)>.lock`.
 *
 * Ownership is fenced to the owning process's identity (pid + start id) so a
 * dead owner's lease is reclaimed automatically on the next acquire — this is
 * what makes crash recovery safe: a crashed worker never permanently strands a
 * session.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface SessionLeaseOwner {
	version: 1;
	token: string;
	pid: number;
	processStartId?: string;
	activeSessionId?: string;
	sessionPath: string;
	createdAt: string;
}

/** Thrown when a session is already owned by a live worker. C5 conflict signal. */
export class SessionAlreadyActiveError extends Error {
	constructor(
		readonly sessionPath: string,
		readonly activeSessionId?: string,
	) {
		super(`Session already active: ${sessionPath}`);
		this.name = "SessionAlreadyActiveError";
	}
}

export interface AcquireSessionLeaseOptions {
	/** Owner session id recorded in the lease (used for conflict diagnostics). */
	ownerId?: string;
	/** Override the current time (tests). */
	now?: () => Date;
}

/** Held session lease. Release removes the lease directory iff we still own it. */
export class SessionLease {
	private released = false;

	constructor(
		readonly sessionPath: string,
		private readonly directory: string,
		private readonly token: string,
	) {}

	release(): void {
		if (this.released) return;
		this.released = true;
		try {
			withLeaseGuard(this.directory, () => {
				const owner = readLeaseOwner(this.directory);
				if (owner?.token === this.token) {
					rmSync(this.directory, { recursive: true, force: true });
				}
			});
		} catch {
			// Lease cleanup is best-effort. A stale owner is reclaimed by the next process.
		}
	}
}

function leaseDirectory(agentDir: string, sessionPath: string): string {
	const key = createHash("sha256").update(sessionPath).digest("hex");
	return join(agentDir, "session-leases", `${key}.lock`);
}

/** Resolve a session path to its canonical realpath so aliases share one lease. */
export function canonicalSessionPath(sessionPath: string): string {
	const resolvedPath = resolve(sessionPath);
	try {
		return realpathSync(resolvedPath);
	} catch {
		try {
			return join(realpathSync(dirname(resolvedPath)), basename(resolvedPath));
		} catch {
			return resolvedPath;
		}
	}
}

function readLeaseOwner(directory: string): SessionLeaseOwner | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as Partial<SessionLeaseOwner>;
		if (
			parsed.version !== 1 ||
			typeof parsed.token !== "string" ||
			typeof parsed.pid !== "number" ||
			typeof parsed.sessionPath !== "string" ||
			typeof parsed.createdAt !== "string"
		) {
			return undefined;
		}
		return parsed as SessionLeaseOwner;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

type ProcessQuery = (command: string, args: string[]) => string;

function runProcessQuery(command: string, args: string[]): string {
	return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function getWindowsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const startTicks = query("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`,
		]).trim();
		return /^\d+$/.test(startTicks) ? `win:${startTicks}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A stable identity for a running pid across the OS's pid-reuse window. Used to
 * fence a lease: a reused pid whose start id differs is treated as dead.
 */
export function getProcessStartId(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "win32") return getWindowsProcessStartId(pid);
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		const fields = stat.slice(commandEnd + 2).split(" ");
		const startTime = fields[19];
		if (startTime) return `proc:${startTime}`;
	} catch {
		// Fall through to the portable process listing used on macOS and BSD.
	}
	try {
		const startTime = runProcessQuery("ps", ["-p", String(pid), "-o", "lstart="]).trim();
		return startTime ? `ps:${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

let currentProcessStartId: string | undefined;
let currentProcessStartIdRead = false;

function getCurrentProcessStartId(): string | undefined {
	if (!currentProcessStartIdRead) {
		currentProcessStartId = getProcessStartId(process.pid);
		currentProcessStartIdRead = true;
	}
	return currentProcessStartId;
}

function isLeaseOwnerAlive(owner: SessionLeaseOwner): boolean {
	if (!isProcessAlive(owner.pid)) return false;
	if (!owner.processStartId) return true;
	const currentStartId = getProcessStartId(owner.pid);
	return currentStartId === undefined || currentStartId === owner.processStartId;
}

/**
 * Serialize the read-owner-then-reclaim path across processes using an atomic
 * `mkdir` as a spin mutex. `mkdir` fails with EEXIST when another process holds
 * the guard; a guard older than {@link GUARD_STALE_MS} is force-reclaimed so a
 * crashed holder cannot wedge the lease.
 */
const GUARD_STALE_MS = 5000;

function withLeaseGuard<T>(directory: string, action: () => T): T {
	const guardPath = `${directory}.guard`;
	let held = false;
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			mkdirSync(guardPath, { recursive: false });
			held = true;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const stat = readFileSync(join(guardPath, ".ts"), "utf8");
				if (Date.now() - Number(stat) > GUARD_STALE_MS) {
					rmSync(guardPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				// No timestamp yet (holder mid-init); briefly back off and retry.
			}
			if (attempt === 199) throw new Error(`Could not coordinate session lease: ${directory}`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	if (!held) throw new Error(`Could not coordinate session lease: ${directory}`);
	try {
		writeFileSync(join(guardPath, ".ts"), String(Date.now()));
	} catch {
		// Timestamp is advisory for stale reclaim; ignore write failures.
	}
	try {
		return action();
	} finally {
		rmSync(guardPath, { recursive: true, force: true });
	}
}

function reclaimStaleLease(directory: string): boolean {
	const stalePath = `${directory}.stale-${process.pid}-${randomUUID()}`;
	try {
		renameSync(directory, stalePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		return false;
	}
	rmSync(stalePath, { recursive: true, force: true });
	return true;
}

/**
 * Acquire the exclusive lease for `sessionPath`. Returns a held {@link SessionLease},
 * or throws {@link SessionAlreadyActiveError} when a live worker already owns it.
 * A lease left by a dead process is reclaimed transparently.
 */
export function acquireSessionLease(
	sessionPath: string,
	agentDir: string,
	options: AcquireSessionLeaseOptions = {},
): SessionLease {
	const canonicalPath = canonicalSessionPath(sessionPath);
	const root = join(agentDir, "session-leases");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const directory = leaseDirectory(agentDir, canonicalPath);
	const createdAt = (options.now?.() ?? new Date()).toISOString();

	return withLeaseGuard(directory, () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const token = randomUUID();
			const candidateDirectory = `${directory}.candidate-${process.pid}-${token}`;
			const owner: SessionLeaseOwner = {
				version: 1,
				token,
				pid: process.pid,
				processStartId: getCurrentProcessStartId(),
				activeSessionId: options.ownerId,
				sessionPath: canonicalPath,
				createdAt,
			};
			mkdirSync(candidateDirectory, { mode: 0o700 });
			writeFileSync(join(candidateDirectory, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
			try {
				renameSync(candidateDirectory, directory);
				return new SessionLease(canonicalPath, directory, token);
			} catch (error) {
				rmSync(candidateDirectory, { recursive: true, force: true });
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
				const existingOwner = readLeaseOwner(directory);
				if (existingOwner && isLeaseOwnerAlive(existingOwner)) {
					throw new SessionAlreadyActiveError(canonicalPath, existingOwner.activeSessionId);
				}
				reclaimStaleLease(directory);
			}
		}
		const owner = existsSync(directory) ? readLeaseOwner(directory) : undefined;
		if (owner && isLeaseOwnerAlive(owner)) {
			throw new SessionAlreadyActiveError(canonicalPath, owner.activeSessionId);
		}
		throw new Error(`Could not acquire session lease: ${canonicalPath}`);
	});
}
