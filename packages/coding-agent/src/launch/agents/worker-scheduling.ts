/**
 * Resident scheduling facade (SPEC §8.2).
 *
 * Composes the ported scheduled-job store + scheduler, goal controller, and
 * autonomous controller into the single {@link WorkerScheduling} surface the
 * resident worker exposes over C4. All four modes reach the session through one
 * {@link SessionPromptInjector}; goal/autonomous continuations are driven off
 * the session's idle transitions. Nothing here touches a kernel — every mode
 * injects a normal prompt.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { WorkerScheduling } from "./agent-worker";
import { emptyGoalCheckpoint, type JobOutcomeData, readLatestGoalCheckpoint, scheduledJobToView } from "./artifacts";
import { AutonomousController } from "./autonomous-controller";
import type {
	AgentAutonomousSpec,
	AgentAutonomousView,
	AgentDeliveryMode,
	AgentGoalSpec,
	AgentGoalView,
	AgentScheduledJobView,
	AgentScheduleSpec,
} from "./control-protocol";
import { GoalController } from "./goal-controller";
import { type ResidentSession, SessionPromptInjector } from "./resident-session";
import { ScheduledJobScheduler, ScheduledJobStore } from "./scheduled-jobs-store";

export class ResidentScheduling implements WorkerScheduling {
	readonly #session: ResidentSession;
	readonly #store: ScheduledJobStore;
	readonly #scheduler: ScheduledJobScheduler;
	readonly #goal: GoalController;
	readonly #autonomous: AutonomousController;
	#unsubscribeRunState?: () => void;
	#afterTurnRunning = false;
	#lastUsage: { input: number; output: number } = { input: 0, output: 0 };

	constructor(session: ResidentSession) {
		this.#session = session;
		const injector = new SessionPromptInjector(session);
		const artifactsDir = session.getArtifactsDir();
		if (!artifactsDir) throw new Error("resident session has no artifacts directory; scheduling requires one");
		this.#store = new ScheduledJobStore(artifactsDir);
		this.#scheduler = new ScheduledJobScheduler(this.#store, {
			injector,
			onOutcome: (outcome: JobOutcomeData) => session.appendJobOutcome(outcome),
			onError: (job, error) =>
				logger.warn("scheduled job failed", {
					jobId: job.id,
					error: error instanceof Error ? error.message : String(error),
				}),
		});
		this.#goal = new GoalController({
			injector,
			persist: data => session.appendGoalCheckpoint(data),
			initial: readLatestGoalCheckpoint(session.getEntries()) ?? emptyGoalCheckpoint(),
		});
		this.#autonomous = new AutonomousController({ injector, cwd: session.cwd });
	}

	start(): void {
		// Re-arm any dispatch interrupted by a prior crash WITHOUT replaying it.
		this.#store.recoverInterrupted();
		this.#scheduler.start();
		// Baseline usage so a resumed session's prior tokens are not counted as one delta.
		this.#lastUsage = this.#session.getUsageTotals();
		// Goal + autonomous continuations run when a turn settles to idle.
		this.#unsubscribeRunState = this.#session.onRunStateChange(busy => {
			if (!busy) void this.#afterTurn();
		});
	}

	stop(): void {
		this.#scheduler.stop();
		this.#unsubscribeRunState?.();
		this.#unsubscribeRunState = undefined;
	}

	async #afterTurn(): Promise<void> {
		if (this.#afterTurnRunning) return;
		this.#afterTurnRunning = true;
		try {
			const totals = this.#session.getUsageTotals();
			const usage = {
				input: Math.max(0, totals.input - this.#lastUsage.input),
				output: Math.max(0, totals.output - this.#lastUsage.output),
			};
			this.#lastUsage = totals;
			this.#goal.recordUsage(usage);
			this.#autonomous.recordUsage(usage);
			await this.#goal.afterTurn();
			await this.#autonomous.afterTurn({ stopReason: null });
		} catch (error) {
			logger.warn("after-turn continuation failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.#afterTurnRunning = false;
		}
	}

	#identity(): { activeSessionId: string; sessionId: string; sessionFile: string; cwd: string } {
		return {
			activeSessionId: this.#session.activeSessionId,
			sessionId: this.#session.sessionId,
			sessionFile: this.#session.sessionFile ?? "",
			cwd: this.#session.cwd,
		};
	}

	addJob(spec: AgentScheduleSpec): AgentScheduledJobView {
		const job = this.#store.create({
			...this.#identity(),
			prompt: spec.prompt,
			scheduleText: spec.schedule,
			label: spec.label,
			deliveryMode: spec.deliveryMode,
			source: "cron",
		});
		this.#scheduler.wake();
		return scheduledJobToView(job);
	}

	listJobs(includeInactive: boolean): AgentScheduledJobView[] {
		return this.#store.list(includeInactive).map(scheduledJobToView);
	}

	cancelJob(jobId: string): boolean {
		const cancelled = this.#store.cancel(jobId);
		this.#scheduler.wake();
		return cancelled;
	}

	setHeartbeat(schedule: string, instruction: string, deliveryMode?: AgentDeliveryMode): AgentScheduledJobView {
		const job = this.#store.setHeartbeat({ ...this.#identity(), schedule, instruction, deliveryMode });
		this.#scheduler.wake();
		return scheduledJobToView(job);
	}

	pauseHeartbeat(): AgentScheduledJobView | undefined {
		const job = this.#store.pauseHeartbeat();
		this.#scheduler.wake();
		return job ? scheduledJobToView(job) : undefined;
	}

	resumeHeartbeat(): AgentScheduledJobView | undefined {
		const job = this.#store.resumeHeartbeat();
		this.#scheduler.wake();
		return job ? scheduledJobToView(job) : undefined;
	}

	clearHeartbeat(): void {
		this.#store.clearHeartbeat();
		this.#scheduler.wake();
	}

	setGoal(spec: AgentGoalSpec): AgentGoalView {
		return this.#goal.set(spec);
	}

	goalStatus(): AgentGoalView {
		return this.#goal.status();
	}

	pauseGoal(): AgentGoalView {
		return this.#goal.pause();
	}

	resumeGoal(): AgentGoalView {
		return this.#goal.resume();
	}

	clearGoal(): AgentGoalView {
		return this.#goal.clear();
	}

	autonomousOn(spec: AgentAutonomousSpec | undefined): AgentAutonomousView {
		return this.#autonomous.on(spec);
	}

	autonomousOff(): AgentAutonomousView {
		return this.#autonomous.off();
	}

	autonomousStatus(): AgentAutonomousView {
		return this.#autonomous.status();
	}
}
