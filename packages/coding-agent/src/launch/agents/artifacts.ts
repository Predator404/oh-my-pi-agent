/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * C5 — Session-artifact paths + entry types (SPEC §8.4, CONTRACTS.md C5).
 *
 * The frozen on-disk contract for the daemon subsystem. Two storage surfaces:
 *
 *  1. Scheduled-job store — a JSON file under the session's artifacts directory
 *     (`<artifacts>/scheduled-jobs.json`). Job shape is ported from Prime
 *     `core/cron-jobs.ts` (minus the `rlm_heartbeat` source, which is dropped
 *     with the RLM model).
 *  2. Goal + job-outcome state — recorded as OMP `custom` session entries with
 *     namespaced `customType`s (`omp.daemon.goal_checkpoint`,
 *     `omp.daemon.job_outcome`). We deliberately DO NOT invent new
 *     SessionEntry variants; namespaced custom entries keep the OMP session
 *     schema unchanged (CONTRACTS.md C5).
 *
 * This module holds only the data shapes, path helpers, and pure readers — the
 * scheduling/goal LOGIC lives in the sibling store/controller modules.
 */

import * as path from "node:path";
import type { AgentDeliveryMode, AgentGoalView, AgentScheduledJobView } from "./control-protocol";

// ---------------------------------------------------------------------------
// Scheduled-job store (scheduled-jobs.json)
// ---------------------------------------------------------------------------

export const SESSION_SCHEDULED_JOBS_FILENAME = "scheduled-jobs.json";

/** Resolve the scheduled-job store path inside a session's artifacts directory. */
export function scheduledJobsPath(artifactsDir: string): string {
	return path.join(artifactsDir, SESSION_SCHEDULED_JOBS_FILENAME);
}

export type AgentJobStatus = "active" | "paused" | "completed" | "cancelled";
export type AgentScheduleKind = "once" | "cron" | "interval";
/** Job origin. Prime's third source (`rlm_heartbeat`) is dropped with the RLM model. */
export type AgentJobSource = "cron" | "heartbeat";

export interface AgentSchedule {
	kind: AgentScheduleKind;
	/** Raw schedule expression: ISO instant (`once`), cron string, or interval literal. */
	expression: string;
	/** Present for `interval` schedules. */
	intervalMs?: number;
}

/**
 * A persisted scheduled job. Ported from Prime `AgentCronJob`. Heartbeats are
 * ordinary jobs with `source: "heartbeat"`; a durable goal drives injection
 * through the autonomous/goal controllers, not this store.
 */
export interface AgentScheduledJob {
	id: string;
	status: AgentJobStatus;
	source: AgentJobSource;
	/** Delivery mode when the target session is busy at fire time. Defaults to "steer". */
	deliveryMode?: AgentDeliveryMode;
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	label?: string;
	prompt: string;
	schedule: AgentSchedule;
	createdAt: string;
	updatedAt: string;
	nextRunAt?: string;
	lastRunAt?: string;
	lastSkippedAt?: string;
	lastError?: string;
	runCount: number;
}

export interface CreateScheduledJobInput {
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	label?: string;
	prompt: string;
	scheduleText: string;
	source?: AgentJobSource;
	deliveryMode?: AgentDeliveryMode;
	now?: Date;
}

/**
 * A claimed-but-not-yet-run dispatch. Written to disk BEFORE the job's prompt is
 * injected so a crash between claim and injection is recoverable without
 * replaying an uncertain prompt (crash-safe claim-and-advance, CONTRACTS.md C5).
 */
export interface AgentJobDispatchRecord {
	id: string;
	jobId: string;
	claimedAt: string;
	scheduledFor: string;
}

/** The full on-disk state persisted to scheduled-jobs.json. */
export interface ScheduledJobsState {
	jobs: AgentScheduledJob[];
	dispatches: AgentJobDispatchRecord[];
}

/** A due, claimed dispatch handed to the injector. */
export interface ScheduledJobDispatch {
	id: string;
	job: AgentScheduledJob;
}

export type ScheduledJobRunResult = "ran" | "skipped";

/** Project a stored job to the client-facing view (C4 `schedule_list`). */
export function scheduledJobToView(job: AgentScheduledJob): AgentScheduledJobView {
	return {
		id: job.id,
		label: job.label,
		source: job.source,
		kind: job.schedule.kind,
		status: job.status,
		prompt: job.prompt,
		schedule: job.schedule.expression,
		deliveryMode: job.deliveryMode,
		nextRunAt: job.nextRunAt,
		lastRunAt: job.lastRunAt,
		runCount: job.runCount,
	};
}

// ---------------------------------------------------------------------------
// Goal state (custom entry: omp.daemon.goal_checkpoint)
// ---------------------------------------------------------------------------

export const GOAL_CHECKPOINT_CUSTOM_TYPE = "omp.daemon.goal_checkpoint";

export type GoalStatus = "idle" | "active" | "paused" | "budget_limited" | "complete" | "error";

/**
 * Persisted goal state. Recorded as a `custom` entry with
 * {@link GOAL_CHECKPOINT_CUSTOM_TYPE}; the latest such entry in the branch is
 * the authoritative state. Ported from Prime `core/goals.ts` `GoalState`.
 */
export interface GoalCheckpointData {
	active: boolean;
	status: GoalStatus;
	goalId?: string;
	objective?: string;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	continuationsUsed: number;
	createdAt?: number;
	updatedAt?: number;
	lastReason?: string;
	lastError?: string;
}

export function emptyGoalCheckpoint(): GoalCheckpointData {
	return { active: false, status: "idle", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 };
}

export function goalCheckpointToView(goal: GoalCheckpointData): AgentGoalView {
	return {
		active: goal.active,
		status: goal.status,
		goalId: goal.goalId,
		objective: goal.objective,
		tokenBudget: goal.tokenBudget,
		tokensUsed: goal.tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds,
		continuationsUsed: goal.continuationsUsed,
	};
}

// ---------------------------------------------------------------------------
// Job outcome (custom entry: omp.daemon.job_outcome)
// ---------------------------------------------------------------------------

export const JOB_OUTCOME_CUSTOM_TYPE = "omp.daemon.job_outcome";

/**
 * A scheduled/goal/autonomous injection outcome. Mirrors OMP's `session_exit`
 * diagnostic pattern (`session/exit-diagnostics.ts`) as a custom entry.
 */
export interface JobOutcomeData {
	jobId: string;
	source: AgentJobSource | "goal" | "autonomous";
	reason: ScheduledJobRunResult | "error";
	/** Turn state observed at the moment of injection. */
	finalTurnState?: "idle" | "streaming" | "aborted";
	error?: string;
	/** Set when the injection scheduled a continuation (goal/autonomous). */
	nextJobId?: string;
	recordedAt: string;
}

// ---------------------------------------------------------------------------
// Pure readers over a session's entry list.
// ---------------------------------------------------------------------------

/** Minimal shape of a `custom` session entry the readers below inspect. */
export interface CustomEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	timestamp?: string;
}

/**
 * The latest goal checkpoint in entry order (entries are append-only, so the
 * last one wins), or undefined if the session has never had a goal.
 */
export function readLatestGoalCheckpoint(entries: readonly CustomEntryLike[]): GoalCheckpointData | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === GOAL_CHECKPOINT_CUSTOM_TYPE) {
			return entry.data as GoalCheckpointData;
		}
	}
	return undefined;
}
