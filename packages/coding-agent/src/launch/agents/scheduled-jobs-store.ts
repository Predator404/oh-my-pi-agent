/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * Scheduled-job store + scheduler (SPEC §8.4, CONTRACTS.md C5).
 *
 * Ported from Prime `core/cron-jobs.ts` `AgentCronJobStore`/`AgentCronScheduler`.
 * Two changes for OMP:
 *
 *  1. Single-writer persistence. The resident worker owns its session's
 *     `scheduled-jobs.json`, so cross-process file locks (`proper-lockfile`) are
 *     dropped for a plain atomic read-modify-write (temp file + rename).
 *  2. Crash-safe claim-and-advance. {@link ScheduledJobStore.claimDue} advances
 *     `nextRunAt`/`lastRunAt`/`runCount` AND writes the dispatch record BEFORE
 *     returning, so a crash between claim and injection never replays an
 *     uncertain prompt: {@link ScheduledJobStore.recoverInterrupted} re-arms the
 *     job for future ticks but never hands the interrupted tick back.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type AgentJobDispatchRecord,
	type AgentJobSource,
	type AgentScheduledJob,
	type AgentScheduleKind,
	type CreateScheduledJobInput,
	type JobOutcomeData,
	type ScheduledJobDispatch,
	type ScheduledJobRunResult,
	type ScheduledJobsState,
	SESSION_SCHEDULED_JOBS_FILENAME,
	scheduledJobsPath,
} from "./artifacts";
import type { AgentDeliveryMode } from "./control-protocol";
import { DEFAULT_HEARTBEAT_DELIVERY_MODE, nextRunAtForSchedule, parseAgentCronSchedule } from "./cron-schedule";
import type { PromptInjector, SessionActivity } from "./prompt-injector";

/** setTimeout caps delays at INT32_MAX ms; longer waits are re-armed on wake. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Heartbeat catalog input for {@link ScheduledJobStore.setHeartbeat}. */
export interface SetHeartbeatInput {
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	schedule: string;
	instruction: string;
	deliveryMode?: AgentDeliveryMode;
	label?: string;
	now?: Date;
}

/**
 * The persistent scheduled-job store for one session's artifacts directory. The
 * resident worker is the single writer; all mutations are read-modify-write with
 * an atomic temp-file rename.
 */
export class ScheduledJobStore {
	private readonly filePath: string;

	/** Accepts either the store file path or the session's artifacts directory. */
	constructor(pathOrArtifactsDir: string) {
		this.filePath = pathOrArtifactsDir.endsWith(SESSION_SCHEDULED_JOBS_FILENAME)
			? pathOrArtifactsDir
			: scheduledJobsPath(pathOrArtifactsDir);
	}

	/** All jobs (active + paused by default), soonest-next-run first. */
	list(includeInactive = false): AgentScheduledJob[] {
		return this.read()
			.jobs.filter(job => includeInactive || job.status === "active" || job.status === "paused")
			.sort((a, b) => compareOptionalIso(a.nextRunAt, b.nextRunAt));
	}

	get(id: string): AgentScheduledJob | undefined {
		return this.read().jobs.find(job => job.id === id);
	}

	create(input: CreateScheduledJobInput): AgentScheduledJob {
		const now = input.now ?? new Date();
		const prompt = input.prompt.trim();
		if (!prompt) {
			throw new Error("Scheduled job prompt cannot be empty");
		}
		const parsed = parseAgentCronSchedule(input.scheduleText, now);
		const nowIso = now.toISOString();
		const job: AgentScheduledJob = {
			id: randomUUID(),
			status: "active",
			source: input.source ?? "cron",
			deliveryMode: input.deliveryMode,
			activeSessionId: input.activeSessionId,
			sessionId: input.sessionId,
			sessionFile: input.sessionFile,
			cwd: input.cwd,
			label: input.label?.trim() || undefined,
			prompt,
			schedule: parsed.schedule,
			createdAt: nowIso,
			updatedAt: nowIso,
			nextRunAt: parsed.nextRunAt.toISOString(),
			runCount: 0,
		};
		this.mutate(state => {
			state.jobs.push(job);
		});
		return job;
	}

	cancel(id: string, now = new Date()): boolean {
		let cancelled = false;
		this.mutate(state => {
			state.jobs = state.jobs.map(job => {
				if (job.id !== id || job.status === "cancelled") {
					return job;
				}
				cancelled = true;
				return { ...job, status: "cancelled", nextRunAt: undefined, updatedAt: now.toISOString() };
			});
		});
		return cancelled;
	}

	pause(id: string, now = new Date()): AgentScheduledJob | undefined {
		let paused: AgentScheduledJob | undefined;
		this.mutate(state => {
			state.jobs = state.jobs.map(job => {
				if (job.id !== id || job.status !== "active") {
					return job;
				}
				paused = { ...job, status: "paused", nextRunAt: undefined, updatedAt: now.toISOString() };
				return paused;
			});
		});
		return paused;
	}

	resume(id: string, now = new Date()): AgentScheduledJob | undefined {
		let resumed: AgentScheduledJob | undefined;
		this.mutate(state => {
			state.jobs = state.jobs.map(job => {
				if (job.id !== id || job.status !== "paused") {
					return job;
				}
				const nextRunAt = nextRunAtForSchedule(job.schedule, now);
				resumed = { ...job, status: "active", nextRunAt: nextRunAt?.toISOString(), updatedAt: now.toISOString() };
				return resumed;
			});
		});
		return resumed;
	}

	// --- heartbeat helpers (the single source: "heartbeat" job per session) ---

	/** The current heartbeat job (active or paused), most-recently-updated first. */
	getHeartbeat(): AgentScheduledJob | undefined {
		return this.read()
			.jobs.filter(job => job.source === "heartbeat" && (job.status === "active" || job.status === "paused"))
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
	}

	/** Replace any existing heartbeat with a new recurring one. */
	setHeartbeat(input: SetHeartbeatInput): AgentScheduledJob {
		const now = input.now ?? new Date();
		const parsed = parseAgentCronSchedule(input.schedule, now);
		if (parsed.schedule.kind === "once") {
			throw new Error("Heartbeat schedule must be recurring");
		}
		const instruction = input.instruction.trim();
		if (!instruction) {
			throw new Error("Heartbeat instruction cannot be empty");
		}
		const nowIso = now.toISOString();
		const job: AgentScheduledJob = {
			id: randomUUID(),
			status: "active",
			source: "heartbeat",
			deliveryMode: input.deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE,
			activeSessionId: input.activeSessionId,
			sessionId: input.sessionId,
			sessionFile: input.sessionFile,
			cwd: input.cwd,
			label: input.label?.trim() || undefined,
			prompt: instruction,
			schedule: parsed.schedule,
			createdAt: nowIso,
			updatedAt: nowIso,
			nextRunAt: parsed.nextRunAt.toISOString(),
			runCount: 0,
		};
		this.mutate(state => {
			state.jobs = state.jobs.map(existing =>
				existing.source === "heartbeat" && (existing.status === "active" || existing.status === "paused")
					? { ...existing, status: "cancelled", nextRunAt: undefined, updatedAt: nowIso }
					: existing,
			);
			state.jobs.push(job);
		});
		return job;
	}

	pauseHeartbeat(now = new Date()): AgentScheduledJob | undefined {
		const current = this.getHeartbeat();
		return current ? this.pause(current.id, now) : undefined;
	}

	resumeHeartbeat(now = new Date()): AgentScheduledJob | undefined {
		const current = this.getHeartbeat();
		return current ? this.resume(current.id, now) : undefined;
	}

	clearHeartbeat(now = new Date()): AgentScheduledJob | undefined {
		const current = this.getHeartbeat();
		if (!current) {
			return undefined;
		}
		let cleared: AgentScheduledJob | undefined;
		this.mutate(state => {
			state.jobs = state.jobs.map(job => {
				if (job.id !== current.id) {
					return job;
				}
				cleared = { ...job, status: "cancelled", nextRunAt: undefined, updatedAt: now.toISOString() };
				return cleared;
			});
		});
		return cleared;
	}

	// --- crash-safe claim-and-advance ----------------------------------------

	/**
	 * Claim every due job. For each, the schedule is advanced (`nextRunAt`,
	 * `lastRunAt`, `runCount`) and a dispatch record is persisted BEFORE the
	 * returned dispatches reach any injector, so the tick is durably consumed.
	 */
	claimDue(now = new Date()): ScheduledJobDispatch[] {
		const nowIso = now.toISOString();
		const dispatches: ScheduledJobDispatch[] = [];
		this.mutate(state => {
			const outstanding = new Set(state.dispatches.map(dispatch => dispatch.jobId));
			state.jobs = state.jobs.map(job => {
				const due =
					job.status === "active" && job.nextRunAt !== undefined && Date.parse(job.nextRunAt) <= now.getTime();
				if (!due) {
					return job;
				}
				const scheduledFor = job.nextRunAt!;
				const nextRunAt = nextRunAtForSchedule(job.schedule, now)?.toISOString();
				const advanced: AgentScheduledJob = {
					...job,
					status: job.schedule.kind === "once" ? "completed" : job.status,
					nextRunAt,
					lastRunAt: nowIso,
					runCount: job.runCount + 1,
					updatedAt: nowIso,
				};
				// A tick with an outstanding dispatch is not re-claimed; just re-arm.
				if (outstanding.has(job.id)) {
					return { ...job, nextRunAt, lastSkippedAt: nowIso, updatedAt: nowIso };
				}
				const record: AgentJobDispatchRecord = {
					id: randomUUID(),
					jobId: job.id,
					claimedAt: nowIso,
					scheduledFor,
				};
				state.dispatches.push(record);
				dispatches.push({ id: record.id, job: advanced });
				return advanced;
			});
		});
		return dispatches;
	}

	/** Retire a claimed dispatch. `skipped` annotates `lastSkippedAt`; an error sets `lastError`. */
	completeDispatch(
		dispatchId: string,
		result: ScheduledJobRunResult,
		error?: unknown,
		now = new Date(),
	): AgentScheduledJob | undefined {
		let updated: AgentScheduledJob | undefined;
		this.mutate(state => {
			const dispatch = state.dispatches.find(candidate => candidate.id === dispatchId);
			if (!dispatch) {
				return;
			}
			state.dispatches = state.dispatches.filter(candidate => candidate.id !== dispatchId);
			const nowIso = now.toISOString();
			state.jobs = state.jobs.map(job => {
				if (job.id !== dispatch.jobId) {
					return job;
				}
				if (result === "skipped") {
					updated = { ...job, lastSkippedAt: nowIso, updatedAt: nowIso };
				} else {
					updated = {
						...job,
						lastError: error === undefined ? undefined : error instanceof Error ? error.message : String(error),
						updatedAt: nowIso,
					};
				}
				return updated;
			});
		});
		return updated;
	}

	/**
	 * Re-arm jobs left with orphaned dispatch records by a prior process. The
	 * dispatch records are cleared and each interrupted active job is annotated,
	 * but the interrupted tick is never returned as an injectable dispatch — the
	 * prior injection outcome is uncertain and MUST NOT be replayed.
	 */
	recoverInterrupted(now = new Date()): AgentScheduledJob[] {
		const recovered: AgentScheduledJob[] = [];
		this.mutate(state => {
			if (state.dispatches.length === 0) {
				return;
			}
			const interruptedJobIds = new Set(state.dispatches.map(dispatch => dispatch.jobId));
			state.dispatches = [];
			const nowIso = now.toISOString();
			state.jobs = state.jobs.map(job => {
				if (!interruptedJobIds.has(job.id) || job.status !== "active") {
					return job;
				}
				const next: AgentScheduledJob = {
					...job,
					lastError: "Interrupted before scheduled operation completion",
					updatedAt: nowIso,
				};
				recovered.push(next);
				return next;
			});
		});
		return recovered;
	}

	/** The soonest active `nextRunAt`, used by the scheduler to arm its timer. */
	nextActiveRunAt(): Date | undefined {
		return this.read()
			.jobs.filter(job => job.status === "active" && job.nextRunAt !== undefined)
			.map(job => new Date(job.nextRunAt!))
			.filter(date => Number.isFinite(date.getTime()))
			.sort((a, b) => a.getTime() - b.getTime())[0];
	}

	private mutate(mutator: (state: ScheduledJobsState) => void): void {
		const state = this.read();
		const before = JSON.stringify(state);
		mutator(state);
		if (JSON.stringify(state) !== before) {
			this.write(state);
		}
	}

	private read(): ScheduledJobsState {
		if (!existsSync(this.filePath)) {
			return { jobs: [], dispatches: [] };
		}
		const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as {
			jobs?: unknown;
			dispatches?: unknown;
		};
		return {
			jobs: Array.isArray(parsed.jobs) ? parsed.jobs.filter(isAgentScheduledJob) : [],
			dispatches: Array.isArray(parsed.dispatches) ? parsed.dispatches.filter(isDispatchRecord) : [],
		};
	}

	private write(state: ScheduledJobsState): void {
		mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
		const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(tempPath, this.filePath);
	}
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** DI hooks for {@link ScheduledJobScheduler}; the injector + clock are seams. */
export interface ScheduledJobSchedulerHooks {
	injector: PromptInjector;
	onOutcome?: (outcome: JobOutcomeData) => void;
	now?: () => Date;
	onError?: (job: AgentScheduledJob, error: unknown) => void;
}

/**
 * Arms a single Node timer to the soonest active `nextRunAt`. On fire it claims
 * every due tick (crash-safe advance), defers heartbeats when the session is
 * busy, injects the rest through the {@link PromptInjector}, and re-arms.
 */
export class ScheduledJobScheduler {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = true;
	private recovered = false;

	constructor(
		private readonly store: ScheduledJobStore,
		private readonly hooks: ScheduledJobSchedulerHooks,
	) {}

	start(): void {
		this.stopped = false;
		if (!this.recovered) {
			this.recovered = true;
			this.store.recoverInterrupted(this.now());
		}
		this.scheduleNext();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	/** Force an immediate re-evaluation (e.g. after a job was added). */
	wake(): void {
		if (!this.stopped) {
			this.scheduleNext(0);
		}
	}

	/** Claim and dispatch every currently-due job. Returns the count injected. */
	async runDue(now = this.now()): Promise<number> {
		if (this.running) {
			return 0;
		}
		this.running = true;
		let dispatches: ScheduledJobDispatch[];
		try {
			dispatches = this.store.claimDue(now);
		} finally {
			this.running = false;
			if (!this.stopped) {
				this.scheduleNext();
			}
		}
		let injected = 0;
		for (const dispatch of dispatches) {
			if (await this.dispatch(dispatch)) {
				injected++;
			}
		}
		return injected;
	}

	private async dispatch(dispatch: ScheduledJobDispatch): Promise<boolean> {
		const job = dispatch.job;
		const activity = this.hooks.injector.activity();
		if (job.source === "heartbeat" && shouldDeferHeartbeat(job, activity)) {
			this.store.completeDispatch(dispatch.id, "skipped", undefined, this.now());
			this.emit(job, "skipped", activity.isStreaming ? "streaming" : "idle");
			return false;
		}
		try {
			const outcome = await this.hooks.injector.injectPrompt(job.prompt, {
				whenBusy: job.deliveryMode ?? "steer",
				label: job.label,
			});
			this.store.completeDispatch(dispatch.id, "ran", undefined, this.now());
			if (outcome === "skipped") {
				this.emit(job, "skipped", "idle");
				return false;
			}
			this.emit(job, "ran", outcome === "started" ? "idle" : "streaming");
			return true;
		} catch (error) {
			this.hooks.onError?.(job, error);
			this.store.completeDispatch(dispatch.id, "ran", error, this.now());
			this.emitError(job, error);
			return false;
		}
	}

	private emit(job: AgentScheduledJob, reason: ScheduledJobRunResult, finalTurnState: "idle" | "streaming"): void {
		this.hooks.onOutcome?.({
			jobId: job.id,
			source: job.source,
			reason,
			finalTurnState,
			recordedAt: this.now().toISOString(),
		});
	}

	private emitError(job: AgentScheduledJob, error: unknown): void {
		this.hooks.onOutcome?.({
			jobId: job.id,
			source: job.source,
			reason: "error",
			error: error instanceof Error ? error.message : String(error),
			recordedAt: this.now().toISOString(),
		});
	}

	private scheduleNext(delayMs?: number): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.stopped) {
			return;
		}
		let delay = delayMs;
		if (delay === undefined) {
			const next = this.store.nextActiveRunAt();
			if (!next) {
				return;
			}
			delay = Math.max(0, next.getTime() - this.now().getTime());
		}
		this.timer = setTimeout(
			() => {
				void this.runDue();
			},
			Math.min(delay, MAX_TIMEOUT_MS),
		);
	}

	private now(): Date {
		return this.hooks.now?.() ?? new Date();
	}
}

/**
 * Decide whether a heartbeat tick must be deferred rather than injected. Ported
 * from Prime `shouldDeferHeartbeatCronJob`: unsafe/redundant session states
 * always defer; a plain streaming turn defers only for `follow_up` heartbeats
 * (a `steer` heartbeat is allowed to interrupt).
 */
export function shouldDeferHeartbeat(job: AgentScheduledJob, activity: SessionActivity): boolean {
	if (job.source !== "heartbeat") {
		return false;
	}
	const busyBesidesStreaming =
		activity.isCompacting ||
		activity.isRetrying ||
		activity.isBashRunning ||
		activity.hasPendingWork ||
		(!activity.isStreaming && activity.unfinishedActionCount > 0);
	if (busyBesidesStreaming) {
		return true;
	}
	const behavior: AgentDeliveryMode = job.deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE;
	if (behavior === "steer") {
		return false;
	}
	return activity.isStreaming;
}

function compareOptionalIso(left: string | undefined, right: string | undefined): number {
	if (left === right) {
		return 0;
	}
	if (left === undefined) {
		return 1;
	}
	if (right === undefined) {
		return -1;
	}
	return Date.parse(left) - Date.parse(right);
}

const SCHEDULE_KINDS: Record<AgentScheduleKind, true> = { once: true, cron: true, interval: true };
const JOB_STATUSES: Record<AgentScheduledJob["status"], true> = {
	active: true,
	paused: true,
	completed: true,
	cancelled: true,
};
const JOB_SOURCES: Record<AgentJobSource, true> = { cron: true, heartbeat: true };

function isAgentScheduledJob(value: unknown): value is AgentScheduledJob {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<AgentScheduledJob>;
	const schedule = candidate.schedule;
	const scheduleOk =
		typeof schedule === "object" &&
		schedule !== null &&
		typeof schedule.expression === "string" &&
		schedule.kind !== undefined &&
		SCHEDULE_KINDS[schedule.kind] === true &&
		(schedule.kind !== "interval" || (typeof schedule.intervalMs === "number" && schedule.intervalMs > 0));
	return (
		typeof candidate.id === "string" &&
		candidate.status !== undefined &&
		JOB_STATUSES[candidate.status] === true &&
		(candidate.source === undefined || JOB_SOURCES[candidate.source] === true) &&
		(candidate.deliveryMode === undefined ||
			candidate.deliveryMode === "steer" ||
			candidate.deliveryMode === "follow_up") &&
		typeof candidate.activeSessionId === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.sessionFile === "string" &&
		typeof candidate.cwd === "string" &&
		(candidate.label === undefined || typeof candidate.label === "string") &&
		typeof candidate.prompt === "string" &&
		scheduleOk &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string" &&
		typeof candidate.runCount === "number"
	);
}

function isDispatchRecord(value: unknown): value is AgentJobDispatchRecord {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<AgentJobDispatchRecord>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.jobId === "string" &&
		typeof candidate.claimedAt === "string" &&
		typeof candidate.scheduledFor === "string"
	);
}
