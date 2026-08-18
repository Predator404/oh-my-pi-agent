/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * Bounded autonomous-mode controller (SPEC §8.4, CONTRACTS.md C5).
 *
 * Ported from Prime `core/autonomous.ts`, minus the RLM coupling. When enabled,
 * each completed turn is offered to {@link AutonomousController.afterTurn}, which
 * enforces the continuation/turn/token/time limits and, when configured, real
 * quality gates. Gates run actual shell commands through `node:child_process`
 * (never a kernel) and only rerun when the git worktree changed since the last
 * failure. A permitted continuation injects an ordinary prompt through the
 * {@link PromptInjector} — there is no autonomous host-request path.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentAutonomousSpec, AgentAutonomousView } from "./control-protocol";
import type { PromptInjector } from "./prompt-injector";

export interface AgentAutonomousConfig {
	enabled?: boolean;
	maxContinuations?: number;
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	continuationPrompt?: string;
	gates?: AgentAutonomousGateConfig;
}

export interface AgentAutonomousGateConfig {
	commands?: string[];
	maxRetries?: number;
	timeoutMs?: number;
}

export interface AgentAutonomousGateFailure {
	command: string;
	attempt: number;
	exitText: string;
	output: string;
}

export interface AutonomousLimits {
	maxContinuations: number;
	maxTurns: number;
	maxTokens: number;
	timeoutMs: number;
}

export const DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT =
	"No human input is available in autonomous mode. Continue working until the host evaluator, verifier, or configured autonomous limits stop the run. If you were asking the user a question, make a reasonable assumption and verify it. If you believe you are blocked, prove it with host-observable evidence, preserve that evidence, and keep looking for safe progress while budget remains. Do not end the session yourself; the verifier/evaluator decides completion when configured gates pass.";

export const DEFAULT_AUTONOMOUS_LIMITS: AutonomousLimits = {
	maxContinuations: 3,
	maxTurns: 12,
	maxTokens: 80_000,
	timeoutMs: 30 * 60 * 1000,
};

export const DEFAULT_AUTONOMOUS_GATES: Required<AgentAutonomousGateConfig> = {
	commands: [],
	maxRetries: 3,
	timeoutMs: 5 * 60 * 1000,
};

const MAX_GATE_OUTPUT_CHARS = 6000;
const MAX_CHILD_PROCESS_OUTPUT_CHARS = 1024 * 1024;

export interface AutonomousRuntimeState {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	startedAt?: number;
	limits: AutonomousLimits;
	continuationPrompt: string;
	gates: Required<AgentAutonomousGateConfig>;
	gateAttempts: Record<string, number>;
	lastGateFailure?: AgentAutonomousGateFailure;
	lastGateFailureSnapshot?: GitWorktreeSnapshot;
}

export type AutonomousLimitReason = "maxContinuations" | "maxTurns" | "maxTokens" | "timeoutMs";
export type AutonomousGateResult = "passed" | "failed" | "retry_exhausted";

export interface AutonomousDecision {
	shouldContinue: boolean;
	reason: "missing_terminal_evidence" | "gate_failed" | "not_needed" | "limit_reached";
}

/** Token usage delta accepted by {@link AutonomousController.recordUsage}. */
export interface AutonomousUsage {
	input: number;
	output: number;
	cacheWrite?: number;
}

/** Completed-turn signal offered to {@link AutonomousController.afterTurn}. */
export interface AutonomousTurn {
	stopReason?: string | null;
}

export interface AutonomousControllerDeps {
	injector: PromptInjector;
	/** Working directory for gate commands + the git worktree snapshot. */
	cwd?: string;
	/** Epoch-ms clock seam; defaults to {@link Date.now}. */
	now?: () => number;
}

interface GitWorktreeSnapshot {
	status: string;
	diff: string;
	untrackedHash: string;
}

interface AutonomousOperationOptions {
	cwd?: string;
	signal?: AbortSignal;
}

interface ChildProcessResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: Error;
	timedOut?: boolean;
	outputTruncated: boolean;
}

// --- runtime-state functions (named contracts / test seam) -----------------

export function createAutonomousRuntimeState(config?: AgentAutonomousConfig): AutonomousRuntimeState {
	const enabled = config?.enabled === true;
	return {
		enabled,
		continuationsUsed: 0,
		turnsUsed: 0,
		tokensUsed: 0,
		startedAt: enabled ? Date.now() : undefined,
		limits: {
			maxContinuations: normalizeLimit(config?.maxContinuations, DEFAULT_AUTONOMOUS_LIMITS.maxContinuations),
			maxTurns: normalizeLimit(config?.maxTurns, DEFAULT_AUTONOMOUS_LIMITS.maxTurns),
			maxTokens: normalizeLimit(config?.maxTokens, DEFAULT_AUTONOMOUS_LIMITS.maxTokens),
			timeoutMs: normalizeLimit(config?.timeoutMs, DEFAULT_AUTONOMOUS_LIMITS.timeoutMs),
		},
		continuationPrompt: config?.continuationPrompt?.trim() || DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT,
		gates: {
			commands: [...(config?.gates?.commands ?? DEFAULT_AUTONOMOUS_GATES.commands)],
			maxRetries: normalizeLimit(config?.gates?.maxRetries, DEFAULT_AUTONOMOUS_GATES.maxRetries),
			timeoutMs: normalizeLimit(config?.gates?.timeoutMs, DEFAULT_AUTONOMOUS_GATES.timeoutMs),
		},
		gateAttempts: {},
	};
}

export function setAutonomousEnabled(state: AutonomousRuntimeState, enabled: boolean): void {
	state.enabled = enabled;
	state.continuationsUsed = enabled ? 0 : state.continuationsUsed;
	state.turnsUsed = enabled ? 0 : state.turnsUsed;
	state.tokensUsed = enabled ? 0 : state.tokensUsed;
	state.startedAt = enabled ? Date.now() : undefined;
	state.gateAttempts = {};
	state.lastGateFailure = undefined;
	state.lastGateFailureSnapshot = undefined;
}

export function autonomousStatus(state: AutonomousRuntimeState): AgentAutonomousView {
	return {
		enabled: state.enabled,
		continuationsUsed: state.continuationsUsed,
		turnsUsed: state.turnsUsed,
		tokensUsed: state.tokensUsed,
		startedAt: state.startedAt,
		limits: { ...state.limits },
	};
}

export function addAutonomousUsage(state: AutonomousRuntimeState, usage: AutonomousUsage | undefined): void {
	if (!state.enabled) {
		return;
	}
	state.turnsUsed++;
	state.tokensUsed += autonomousTokenDelta(usage);
}

export function addAutonomousContinuation(state: AutonomousRuntimeState): void {
	if (state.enabled) {
		state.continuationsUsed++;
	}
}

/**
 * Cache-read tokens are repeated context served from the provider cache, so they
 * are excluded; cache-WRITE (creation) is billed fresh work and counts toward
 * the token cap alongside input/output.
 */
function autonomousTokenDelta(usage: AutonomousUsage | undefined): number {
	if (!usage) {
		return 0;
	}
	return usage.input + usage.output + (usage.cacheWrite ?? 0);
}

export function autonomousLimitReason(
	state: AutonomousRuntimeState,
	now = Date.now(),
): AutonomousLimitReason | undefined {
	if (state.continuationsUsed >= state.limits.maxContinuations) {
		return "maxContinuations";
	}
	if (state.turnsUsed >= state.limits.maxTurns) {
		return "maxTurns";
	}
	if (state.tokensUsed >= state.limits.maxTokens) {
		return "maxTokens";
	}
	if (state.startedAt !== undefined && now - state.startedAt >= state.limits.timeoutMs) {
		return "timeoutMs";
	}
	return undefined;
}

export async function shouldAutonomouslyContinue(
	state: AutonomousRuntimeState,
	message: AutonomousTurn,
	options: AutonomousOperationOptions = {},
	now = Date.now(),
): Promise<AutonomousDecision> {
	options.signal?.throwIfAborted();
	if (!state.enabled || message.stopReason === "error" || message.stopReason === "aborted") {
		return { shouldContinue: false, reason: "not_needed" };
	}
	const gateResult = await refreshAutonomousQualityGates(state, options);
	options.signal?.throwIfAborted();
	if (gateResult) {
		if (gateResult === "passed") {
			return { shouldContinue: false, reason: "not_needed" };
		}
		if (gateResult === "retry_exhausted" || autonomousLimitReason(state, now)) {
			return { shouldContinue: false, reason: "limit_reached" };
		}
		return { shouldContinue: true, reason: "gate_failed" };
	}
	if (autonomousLimitReason(state, now)) {
		return { shouldContinue: false, reason: "limit_reached" };
	}
	return { shouldContinue: true, reason: "missing_terminal_evidence" };
}

export async function refreshAutonomousQualityGates(
	state: AutonomousRuntimeState,
	options: AutonomousOperationOptions = {},
): Promise<AutonomousGateResult | undefined> {
	options.signal?.throwIfAborted();
	if (!state.enabled || state.gates.commands.length === 0) {
		return undefined;
	}
	return runAutonomousQualityGates(state, options.cwd, options.signal);
}

export function buildAutonomousGateFailureContinuation(
	failure: AgentAutonomousGateFailure,
	maxRetries: number,
	timestamp = Date.now(),
): string {
	return (
		`Autonomous quality gate failed (attempt ${failure.attempt}/${maxRetries}): \`${failure.command}\` ${failure.exitText}.\n` +
		(failure.output ? `\nOutput:\n${failure.output}\n` : "\n") +
		`\nContinue working. Fix the failure, then produce terminal evidence. Timestamp: ${new Date(timestamp).toISOString()}.`
	);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const AUTONOMOUS_LABEL = "autonomous";

/**
 * Wraps an {@link AutonomousRuntimeState} and the injector seam. `on`/`off`
 * toggle bounded autonomous mode; `recordUsage` accrues turn/token spend; and
 * `afterTurn` injects a continuation prompt when the limits and quality gates
 * permit, returning whether it continued.
 */
export class AutonomousController {
	private state: AutonomousRuntimeState;

	constructor(private readonly deps: AutonomousControllerDeps) {
		this.state = createAutonomousRuntimeState();
	}

	on(spec?: AgentAutonomousSpec): AgentAutonomousView {
		this.state = createAutonomousRuntimeState({ enabled: true, ...spec });
		return this.status();
	}

	off(): AgentAutonomousView {
		setAutonomousEnabled(this.state, false);
		return this.status();
	}

	status(): AgentAutonomousView {
		return autonomousStatus(this.state);
	}

	recordUsage(usage: AutonomousUsage | undefined): void {
		addAutonomousUsage(this.state, usage);
	}

	async afterTurn(assistantMessage: AutonomousTurn, options: { signal?: AbortSignal } = {}): Promise<boolean> {
		options.signal?.throwIfAborted();
		if (!this.state.enabled) {
			return false;
		}
		const now = this.now();
		const decision = await shouldAutonomouslyContinue(
			this.state,
			assistantMessage,
			{ cwd: this.deps.cwd, signal: options.signal },
			now,
		);
		options.signal?.throwIfAborted();
		if (!decision.shouldContinue) {
			return false;
		}
		this.state.continuationsUsed++;
		const failure = this.state.lastGateFailure;
		const prompt =
			decision.reason === "gate_failed" && failure
				? buildAutonomousGateFailureContinuation(failure, this.state.gates.maxRetries, now)
				: this.state.continuationPrompt;
		await this.deps.injector.injectPrompt(prompt, { whenBusy: "follow_up", label: AUTONOMOUS_LABEL });
		return true;
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}
}

// --- quality gates + git worktree snapshot ---------------------------------

async function runAutonomousQualityGates(
	state: AutonomousRuntimeState,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
): Promise<AutonomousGateResult> {
	signal?.throwIfAborted();
	if (!cwd) {
		return "failed";
	}
	for (const command of state.gates.commands) {
		const currentSnapshot = await captureGitWorktreeSnapshot(cwd, signal);
		signal?.throwIfAborted();
		if (
			state.lastGateFailure?.command === command &&
			state.lastGateFailureSnapshot &&
			gitWorktreeSnapshotsEqual(currentSnapshot, state.lastGateFailureSnapshot)
		) {
			const attempt = (state.gateAttempts[command] ?? state.lastGateFailure.attempt) + 1;
			state.gateAttempts[command] = attempt;
			state.lastGateFailure = {
				...state.lastGateFailure,
				attempt,
				exitText: "not rerun: workspace unchanged since previous failed gate",
				output:
					"The autonomous gate was not rerun because the workspace has not changed since this failure. Edit source files, tests, or a blocker artifact before attempting to finish again.",
			};
			return attempt > state.gates.maxRetries ? "retry_exhausted" : "failed";
		}
		const result = await runChildProcess(command, [], {
			cwd,
			shell: true,
			timeoutMs: state.gates.timeoutMs,
			maxOutputChars: MAX_GATE_OUTPUT_CHARS,
			signal,
		});
		signal?.throwIfAborted();
		const postRunSnapshot = await captureGitWorktreeSnapshot(cwd, signal);
		signal?.throwIfAborted();
		if (result.status === 0 && !result.error && !result.timedOut) {
			state.gateAttempts[command] = 0;
			if (state.lastGateFailure?.command === command) {
				state.lastGateFailure = undefined;
				state.lastGateFailureSnapshot = undefined;
			}
			continue;
		}
		const attempt = (state.gateAttempts[command] ?? 0) + 1;
		state.gateAttempts[command] = attempt;
		state.lastGateFailure = {
			command,
			attempt,
			exitText: formatProcessExit(result),
			output: truncateGateOutput(
				[result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
				result.outputTruncated,
			),
		};
		state.lastGateFailureSnapshot = postRunSnapshot;
		return attempt > state.gates.maxRetries ? "retry_exhausted" : "failed";
	}
	state.lastGateFailure = undefined;
	state.lastGateFailureSnapshot = undefined;
	return "passed";
}

function gitWorktreeSnapshotsEqual(a: GitWorktreeSnapshot | undefined, b: GitWorktreeSnapshot | undefined): boolean {
	return !!a && !!b && a.status === b.status && a.diff === b.diff && a.untrackedHash === b.untrackedHash;
}

async function captureGitWorktreeSnapshot(
	cwd: string | undefined,
	signal?: AbortSignal,
): Promise<GitWorktreeSnapshot | undefined> {
	signal?.throwIfAborted();
	if (!cwd) {
		return undefined;
	}
	const pathspec = ["--", "."];
	const status = await runChildProcess(
		"git",
		["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall", "--no-renames", ...pathspec],
		{ cwd, timeoutMs: 10_000, signal },
	);
	signal?.throwIfAborted();
	if (status.status !== 0 || status.error || status.timedOut || status.outputTruncated) {
		return undefined;
	}
	const diff = await runChildProcess(
		"git",
		["--no-optional-locks", "diff", "--no-ext-diff", "--binary", "HEAD", ...pathspec],
		{
			cwd,
			timeoutMs: 10_000,
			signal,
		},
	);
	signal?.throwIfAborted();
	if (diff.status !== 0 || diff.error || diff.timedOut || diff.outputTruncated) {
		return undefined;
	}
	return {
		status: status.stdout,
		diff: diff.stdout,
		untrackedHash: await hashUntrackedFiles(cwd, status.stdout, signal),
	};
}

async function hashUntrackedFiles(cwd: string, status: string, signal?: AbortSignal): Promise<string> {
	const aggregate = createHash("sha256");
	const untracked = status
		.split("\0")
		.filter(entry => entry.startsWith("?? "))
		.map(entry => entry.slice(3))
		.sort();
	for (const path of untracked) {
		signal?.throwIfAborted();
		aggregate.update(path);
		aggregate.update("\0");
		aggregate.update(await hashUntrackedPath(resolve(cwd, path), signal));
		aggregate.update("\0");
	}
	signal?.throwIfAborted();
	return aggregate.digest("hex");
}

async function hashUntrackedPath(path: string, signal?: AbortSignal): Promise<string> {
	try {
		signal?.throwIfAborted();
		const stat = await lstat(path);
		signal?.throwIfAborted();
		if (stat.isSymbolicLink()) {
			return `symlink:${await readlink(path)}`;
		}
		if (!stat.isFile()) {
			return `other:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
		}
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(path, { signal })) {
			hash.update(chunk);
		}
		signal?.throwIfAborted();
		return `file:${hash.digest("hex")}`;
	} catch (error) {
		signal?.throwIfAborted();
		return `error:${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Run a gate/git command directly (no kernel). On non-Windows the child leads
 * its own process group so a timeout/abort kills the whole tree.
 */
function runChildProcess(
	command: string,
	args: string[],
	options: { cwd?: string; shell?: boolean; timeoutMs?: number; maxOutputChars?: number; signal?: AbortSignal } = {},
): Promise<ChildProcessResult> {
	options.signal?.throwIfAborted();
	const { promise, resolve: settle } = Promise.withResolvers<ChildProcessResult>();
	const child = spawn(command, args, {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		shell: options.shell === true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let error: Error | undefined;
	let timedOut = false;
	let outputTruncated = false;
	let settled = false;
	const maxOutputChars = options.maxOutputChars ?? MAX_CHILD_PROCESS_OUTPUT_CHARS;
	const killTree = () => {
		try {
			if (child.pid && process.platform !== "win32") {
				process.kill(-child.pid, "SIGKILL");
			} else {
				child.kill("SIGKILL");
			}
		} catch {
			// Already exited.
		}
	};
	const abort = () => {
		killTree();
	};
	const timer = options.timeoutMs
		? setTimeout(() => {
				timedOut = true;
				killTree();
			}, options.timeoutMs)
		: undefined;
	const finish = (result: Pick<ChildProcessResult, "status" | "signal">) => {
		if (settled) {
			return;
		}
		settled = true;
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		settle({ ...result, stdout, stderr, error, timedOut, outputTruncated });
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) {
		abort();
	}
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		const remaining = maxOutputChars - stdout.length;
		if (remaining > 0) {
			stdout += chunk.slice(0, remaining);
		}
		outputTruncated ||= chunk.length > remaining;
	});
	child.stderr?.on("data", (chunk: string) => {
		const remaining = maxOutputChars - stderr.length;
		if (remaining > 0) {
			stderr += chunk.slice(0, remaining);
		}
		outputTruncated ||= chunk.length > remaining;
	});
	child.on("error", (err: Error) => {
		error = err;
		finish({ status: child.exitCode, signal: child.signalCode });
	});
	child.on("close", (code, signalCode) => {
		finish({ status: code, signal: signalCode });
	});
	return promise;
}

function formatProcessExit(result: ChildProcessResult): string {
	if (result.timedOut) {
		return "timed out";
	}
	if (result.error) {
		return result.error.message;
	}
	return result.signal ? `terminated by ${result.signal}` : `exited ${result.status ?? "unknown"}`;
}

function truncateGateOutput(output: string, outputAlreadyTruncated = false, maxChars = MAX_GATE_OUTPUT_CHARS): string {
	if (output.length <= maxChars && !outputAlreadyTruncated) {
		return output;
	}
	return `${output.slice(0, maxChars)}\n... [truncated]`;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return Math.trunc(value);
}
