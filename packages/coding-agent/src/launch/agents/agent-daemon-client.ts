/**
 * High-level C4 client (SPEC §12, CONTRACTS.md C4 consumers WS5/WS7).
 *
 * A thin, typed facade over the broker socket for driving resident agent
 * sessions: spawn/attach/detach/list/stop, prompt/steer/follow_up, peer
 * send_message, and the schedule/heartbeat/goal/autonomous surface. It hides the
 * command-envelope + `agent` DaemonOperation plumbing so the CLI/TUI (WS7) and
 * the peer layer (WS5) call plain methods and subscribe to session events.
 */

import type { DaemonBrokerClient } from "../client";
import {
	type ActiveSessionId,
	type AgentAttachResult,
	type AgentAutonomousSpec,
	type AgentAutonomousView,
	type AgentClientCapability,
	type AgentControlCommand,
	type AgentControlEventEnvelope,
	type AgentControlResult,
	type AgentDeliveryMode,
	type AgentEventCursor,
	type AgentGoalSpec,
	type AgentGoalView,
	type AgentMessageMode,
	type AgentMessageReceipt,
	type AgentScheduledJobView,
	type AgentScheduleSpec,
	type AgentSessionSummary,
	createAgentCommandEnvelope,
} from "./control-protocol";

function agentError(result: AgentControlResult): Error {
	if (result.ok === false) {
		const error = new Error(`${result.error.code}: ${result.error.message}`);
		error.name = "AgentControlError";
		return error;
	}
	return new Error(`unexpected agent result for ${result.type}`);
}

export class AgentDaemonClient {
	readonly #broker: DaemonBrokerClient;
	readonly #clientId: string;

	constructor(broker: DaemonBrokerClient, clientId: string = crypto.randomUUID()) {
		this.#broker = broker;
		this.#clientId = clientId;
	}

	get clientId(): string {
		return this.#clientId;
	}

	/**
	 * Send one raw command and return its typed result. `commandId` keys the
	 * broker's idempotency journal — reuse it on a retry to avoid re-running a
	 * mutation whose outcome you did not observe.
	 */
	async command(command: AgentControlCommand, commandId: string = crypto.randomUUID()): Promise<AgentControlResult> {
		const envelope = createAgentCommandEnvelope(command, commandId, this.#clientId);
		const result = await this.#broker.request({ op: "agent", envelope });
		if (result.op !== "agent") throw new Error(`broker returned ${result.op} for an agent command`);
		return result.response;
	}

	/** Subscribe to a session's event stream (messages/status/goal/etc.). */
	onEvent(id: ActiveSessionId, sink: (envelope: AgentControlEventEnvelope) => void): () => void {
		if (!this.#broker.onAgentEvent) throw new Error("broker does not support agent event streaming");
		return this.#broker.onAgentEvent(id, sink);
	}

	async spawn(entityName: string, cwd?: string): Promise<AgentSessionSummary> {
		const result = await this.command({ type: "spawn", entityName, cwd });
		if (result.type === "spawn" && result.ok) return result.summary;
		throw agentError(result);
	}

	async attach(
		id: ActiveSessionId,
		options: { capabilities?: AgentClientCapability[]; resume?: AgentEventCursor } = {},
	): Promise<AgentAttachResult> {
		const result = await this.command({
			type: "attach",
			id,
			capabilities: options.capabilities,
			resume: options.resume,
		});
		if (result.type === "attach" && result.ok) return result.result;
		throw agentError(result);
	}

	async detach(id: ActiveSessionId): Promise<void> {
		const result = await this.command({ type: "detach", id });
		if (!(result.type === "detach" && result.ok)) throw agentError(result);
	}

	async list(): Promise<AgentSessionSummary[]> {
		const result = await this.command({ type: "list" });
		if (result.type === "list" && result.ok) return result.sessions;
		throw agentError(result);
	}

	async stop(id: ActiveSessionId): Promise<void> {
		const result = await this.command({ type: "stop", id });
		if (!(result.type === "stop" && result.ok)) throw agentError(result);
	}

	async prompt(id: ActiveSessionId, text: string): Promise<void> {
		const result = await this.command({ type: "prompt", id, text });
		if (!(result.type === "prompt" && result.ok)) throw agentError(result);
	}

	async steer(id: ActiveSessionId, text: string): Promise<void> {
		const result = await this.command({ type: "steer", id, text });
		if (!(result.type === "steer" && result.ok)) throw agentError(result);
	}

	async followUp(id: ActiveSessionId, text: string): Promise<void> {
		const result = await this.command({ type: "follow_up", id, text });
		if (!(result.type === "follow_up" && result.ok)) throw agentError(result);
	}

	async sendMessage(
		target: string,
		text: string,
		mode: AgentMessageMode = "auto",
		from?: string,
	): Promise<AgentMessageReceipt> {
		const result = await this.command({ type: "send_message", target, text, mode, from });
		if (result.type === "send_message" && result.ok) return result.receipt;
		throw agentError(result);
	}

	async scheduleAdd(id: ActiveSessionId, spec: AgentScheduleSpec): Promise<AgentScheduledJobView> {
		const result = await this.command({ type: "schedule_add", id, spec });
		if (result.type === "schedule_add" && result.ok) return result.job;
		throw agentError(result);
	}

	async scheduleList(id: ActiveSessionId, includeInactive = false): Promise<AgentScheduledJobView[]> {
		const result = await this.command({ type: "schedule_list", id, includeInactive });
		if (result.type === "schedule_list" && result.ok) return result.jobs;
		throw agentError(result);
	}

	async scheduleCancel(id: ActiveSessionId, jobId: string): Promise<boolean> {
		const result = await this.command({ type: "schedule_cancel", id, jobId });
		if (result.type === "schedule_cancel" && result.ok) return result.cancelled;
		throw agentError(result);
	}

	async heartbeatSet(
		id: ActiveSessionId,
		schedule: string,
		instruction: string,
		deliveryMode?: AgentDeliveryMode,
	): Promise<AgentScheduledJobView | undefined> {
		const result = await this.command({ type: "heartbeat_set", id, schedule, instruction, deliveryMode });
		if (result.type === "heartbeat_set" && result.ok) return result.job;
		throw agentError(result);
	}

	async heartbeatPause(id: ActiveSessionId): Promise<void> {
		const result = await this.command({ type: "heartbeat_pause", id });
		if (!(result.type === "heartbeat_pause" && result.ok)) throw agentError(result);
	}

	async heartbeatResume(id: ActiveSessionId): Promise<void> {
		const result = await this.command({ type: "heartbeat_resume", id });
		if (!(result.type === "heartbeat_resume" && result.ok)) throw agentError(result);
	}

	async heartbeatClear(id: ActiveSessionId): Promise<void> {
		const result = await this.command({ type: "heartbeat_clear", id });
		if (!(result.type === "heartbeat_clear" && result.ok)) throw agentError(result);
	}

	async goalSet(id: ActiveSessionId, spec: AgentGoalSpec): Promise<AgentGoalView> {
		const result = await this.command({ type: "goal_set", id, spec });
		if (result.type === "goal_set" && result.ok) return result.goal;
		throw agentError(result);
	}

	async goalStatus(id: ActiveSessionId): Promise<AgentGoalView> {
		const result = await this.command({ type: "goal_status", id });
		if (result.type === "goal_status" && result.ok) return result.goal;
		throw agentError(result);
	}

	async goalPause(id: ActiveSessionId): Promise<AgentGoalView> {
		const result = await this.command({ type: "goal_pause", id });
		if (result.type === "goal_pause" && result.ok) return result.goal;
		throw agentError(result);
	}

	async goalResume(id: ActiveSessionId): Promise<AgentGoalView> {
		const result = await this.command({ type: "goal_resume", id });
		if (result.type === "goal_resume" && result.ok) return result.goal;
		throw agentError(result);
	}

	async goalClear(id: ActiveSessionId): Promise<AgentGoalView> {
		const result = await this.command({ type: "goal_clear", id });
		if (result.type === "goal_clear" && result.ok) return result.goal;
		throw agentError(result);
	}

	async autonomousOn(id: ActiveSessionId, spec?: AgentAutonomousSpec): Promise<AgentAutonomousView> {
		const result = await this.command({ type: "autonomous_on", id, spec });
		if (result.type === "autonomous_on" && result.ok) return result.status;
		throw agentError(result);
	}

	async autonomousOff(id: ActiveSessionId): Promise<AgentAutonomousView> {
		const result = await this.command({ type: "autonomous_off", id });
		if (result.type === "autonomous_off" && result.ok) return result.status;
		throw agentError(result);
	}

	async autonomousStatus(id: ActiveSessionId): Promise<AgentAutonomousView> {
		const result = await this.command({ type: "autonomous_status", id });
		if (result.type === "autonomous_status" && result.ok) return result.status;
		throw agentError(result);
	}
}
