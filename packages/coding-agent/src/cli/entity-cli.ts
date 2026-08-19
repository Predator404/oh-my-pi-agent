/**
 * WS7 — operator surface for the persistent multi-entity runtime (SPEC §12.7).
 *
 * `runEntityCommand` is the single dispatch entry the `omp entity` command
 * delegates to. It covers three surfaces:
 *   - **Registry/config** (WS2): `roster`/`list`, `show`, `create`, `config`.
 *   - **Runtime** (WS1 C4 over {@link AgentDaemonClient}): `spawn`, `ps`,
 *     `attach`, `detach`, `stop`, `prompt`, `steer`, `follow-up`, `send`,
 *     `schedule`, `heartbeat`, `goal`, `autonomous` — every C4 command.
 *   - **Bootstrap** (WS7a): `setup`.
 *
 * All I/O and heavyweight collaborators are injected via {@link EntityCommandDeps}
 * so command dispatch is unit-testable without a live broker or the registry's
 * native dependencies; {@link defaultEntityDeps} wires the real implementations.
 */

import type { EntityDiscoveryResult } from "../entity/loader";
import type { CreateEntityFields, WriteEntityRecordResult } from "../entity/record-writer";
import type { ResolvedEntityConfig } from "../entity/schema";
import type { EntitySetupOptions, SetupReport } from "../entity/setup";
import type {
	AgentAttachResult,
	AgentAutonomousSpec,
	AgentAutonomousView,
	AgentDeliveryMode,
	AgentGoalSpec,
	AgentGoalView,
	AgentMessageMode,
	AgentMessageReceipt,
	AgentScheduledJobView,
	AgentScheduleSpec,
	AgentSessionSummary,
} from "../launch/agents/control-protocol";

/**
 * The subset of {@link AgentDaemonClient} the operator surface drives. Every C4
 * command is reachable through it. Declared as an interface (not the class) so a
 * test double satisfies it structurally.
 */
export interface EntityRuntimeClient {
	spawn(entityName: string, cwd?: string): Promise<AgentSessionSummary>;
	list(): Promise<AgentSessionSummary[]>;
	attach(id: string): Promise<AgentAttachResult>;
	detach(id: string): Promise<void>;
	stop(id: string): Promise<void>;
	prompt(id: string, text: string): Promise<void>;
	steer(id: string, text: string): Promise<void>;
	followUp(id: string, text: string): Promise<void>;
	sendMessage(target: string, text: string, mode?: AgentMessageMode, from?: string): Promise<AgentMessageReceipt>;
	scheduleAdd(id: string, spec: AgentScheduleSpec): Promise<AgentScheduledJobView>;
	scheduleList(id: string, includeInactive?: boolean): Promise<AgentScheduledJobView[]>;
	scheduleCancel(id: string, jobId: string): Promise<boolean>;
	heartbeatSet(
		id: string,
		schedule: string,
		instruction: string,
		deliveryMode?: AgentDeliveryMode,
	): Promise<AgentScheduledJobView | undefined>;
	heartbeatPause(id: string): Promise<void>;
	heartbeatResume(id: string): Promise<void>;
	heartbeatClear(id: string): Promise<void>;
	goalSet(id: string, spec: AgentGoalSpec): Promise<AgentGoalView>;
	goalStatus(id: string): Promise<AgentGoalView>;
	goalPause(id: string): Promise<AgentGoalView>;
	goalResume(id: string): Promise<AgentGoalView>;
	goalClear(id: string): Promise<AgentGoalView>;
	autonomousOn(id: string, spec?: AgentAutonomousSpec): Promise<AgentAutonomousView>;
	autonomousOff(id: string): Promise<AgentAutonomousView>;
	autonomousStatus(id: string): Promise<AgentAutonomousView>;
	/**
	 * Release the broker connection. A one-shot CLI invocation MUST close it so
	 * its persistent socket stops pinning Bun's event loop — otherwise `spawn`
	 * and `ps` print their result and then hang instead of returning, leaving the
	 * detached broker+worker with no clean client exit. Optional so structural
	 * test doubles need not implement it.
	 */
	close?(): void;
}

/** Parsed flags accepted by `omp entity <action>`. */
export interface EntityCommandFlags {
	json?: boolean;
	cwd?: string;
	registry?: string;
	force?: boolean;
	// send / heartbeat / schedule delivery
	mode?: string;
	delivery?: string;
	label?: string;
	includeInactive?: boolean;
	// goal
	budget?: number;
	// autonomous
	maxContinuations?: number;
	maxTurns?: number;
	maxTokens?: number;
	timeout?: number;
	// create / config
	role?: string;
	description?: string;
	model?: string;
	thinking?: string;
	tools?: string;
	skills?: string;
	bank?: string;
	autoRetain?: boolean;
	vaultSection?: string;
	endpoint?: string;
	prompt?: string;
	set?: string[];
	// setup
	vault?: string;
	registrySource?: string;
	noEndpoints?: boolean;
	warmCache?: boolean;
}

export interface EntityCommand {
	action: string;
	args: string[];
	flags: EntityCommandFlags;
}

/** Collaborators for {@link runEntityCommand}; overridable in tests. */
export interface EntityCommandDeps {
	write(text: string): void;
	connectClient(): Promise<EntityRuntimeClient>;
	discover(options: { registryRoot?: string }): Promise<EntityDiscoveryResult>;
	resolve(name: string, options: { registryRoot?: string }): Promise<ResolvedEntityConfig>;
	createRecord(
		name: string,
		fields: CreateEntityFields,
		options: { registryRoot?: string; force?: boolean },
	): Promise<WriteEntityRecordResult>;
	updateRecord(
		name: string,
		updates: Array<{ key: string; value: string }>,
		options: { registryRoot?: string },
	): Promise<WriteEntityRecordResult>;
	runSetup(options: EntitySetupOptions): Promise<SetupReport>;
	readStdin(): Promise<string>;
}

/** Thrown for user-facing usage errors (bad action, missing arg). */
export class EntityCommandUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EntityCommandUsageError";
	}
}

function requireArg(args: string[], index: number, label: string): string {
	const value = args[index];
	if (value === undefined || value === "") throw new EntityCommandUsageError(`missing required argument: ${label}`);
	return value;
}

function joinRest(args: string[], from: number, label: string): string {
	const text = args.slice(from).join(" ").trim();
	if (!text) throw new EntityCommandUsageError(`missing required argument: ${label}`);
	return text;
}

function parseCsv(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const list = value
		.split(",")
		.map(s => s.trim())
		.filter(Boolean);
	return list.length ? list : undefined;
}

function emit(deps: EntityCommandDeps, json: boolean | undefined, value: unknown, text: string): void {
	deps.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

function formatSummary(s: AgentSessionSummary): string {
	const flags = [s.busy ? "busy" : "idle", s.attached ? "attached" : "detached", s.workerState].join("/");
	return `${s.id}  ${s.entityName}  [${flags}]  ${s.cwd}`;
}

function formatJob(j: AgentScheduledJobView): string {
	const next = j.nextRunAt ? ` next=${j.nextRunAt}` : "";
	return `${j.id}  ${j.source}/${j.kind}  ${j.status}  "${j.schedule}"${next}  runs=${j.runCount}${j.label ? `  (${j.label})` : ""}`;
}

function parseMessageMode(mode: string | undefined): AgentMessageMode {
	if (mode === undefined) return "auto";
	if (mode === "auto" || mode === "steer" || mode === "follow_up") return mode;
	throw new EntityCommandUsageError(`--mode must be one of auto|steer|follow_up, got "${mode}"`);
}

function parseDeliveryMode(mode: string | undefined): AgentDeliveryMode | undefined {
	if (mode === undefined) return undefined;
	if (mode === "steer" || mode === "follow_up") return mode;
	throw new EntityCommandUsageError(`--delivery must be one of steer|follow_up, got "${mode}"`);
}

/** Dispatch one `omp entity` invocation. Throws {@link EntityCommandUsageError} on bad input. */
export async function runEntityCommand(cmd: EntityCommand, deps: EntityCommandDeps): Promise<void> {
	const { action, args, flags } = cmd;
	const registryRoot = flags.registry;
	const json = flags.json;

	switch (action) {
		case "roster":
		case "list": {
			const { entities, errors } = await deps.discover({ registryRoot });
			if (json) {
				emit(deps, true, { entities, errors }, "");
				return;
			}
			if (entities.length === 0) deps.write("No entities defined.\n");
			for (const e of entities) {
				deps.write(
					`${e.name}  (${e.role})  ${e.model?.join(",") ?? "—"}  bank=${e.memory.bank}  §${e.vaultSection}\n`,
				);
			}
			for (const err of errors) deps.write(`! ${err.filePath}: ${err.error}\n`);
			return;
		}
		case "show": {
			const name = requireArg(args, 0, "name");
			const config = await deps.resolve(name, { registryRoot });
			if (json) return emit(deps, true, config, "");
			deps.write(`${config.name}  (${config.role})\n`);
			deps.write(`  description : ${config.description}\n`);
			deps.write(`  model       : ${config.model?.join(",") ?? "—"}\n`);
			deps.write(`  thinking    : ${config.thinkingLevel ?? "—"}\n`);
			deps.write(`  tools       : ${config.tools?.join(",") ?? "—"}\n`);
			deps.write(`  skills      : ${config.autoloadSkills?.join(",") ?? "—"}\n`);
			deps.write(
				`  memory      : ${config.memory.backend}/${config.memory.bank} autoRetain=${config.memory.autoRetain}\n`,
			);
			deps.write(`  vaultSection: ${config.vaultSection}\n`);
			deps.write(`  hosting     : ${config.hosting?.modelEndpoint ?? "—"}\n`);
			return;
		}
		case "create": {
			const name = requireArg(args, 0, "name");
			const role = flags.role;
			if (role !== "agent" && role !== "persona") throw new EntityCommandUsageError(`--role must be agent|persona`);
			const description = flags.description;
			if (!description) throw new EntityCommandUsageError(`--description is required`);
			let systemPrompt = flags.prompt ?? "";
			if (!systemPrompt) systemPrompt = (await deps.readStdin()).trim();
			if (!systemPrompt)
				throw new EntityCommandUsageError(`system prompt required (pass --prompt or pipe it on stdin)`);
			const fields: CreateEntityFields = {
				role,
				description,
				systemPrompt,
				model: parseCsv(flags.model),
				thinkingLevel: flags.thinking,
				tools: parseCsv(flags.tools),
				autoloadSkills: parseCsv(flags.skills),
				memory: { bank: flags.bank, autoRetain: flags.autoRetain },
				vaultSection: flags.vaultSection,
				hosting: flags.endpoint ? { modelEndpoint: flags.endpoint } : undefined,
			};
			const result = await deps.createRecord(name, fields, { registryRoot, force: flags.force });
			return emit(
				deps,
				json,
				result,
				`${result.created ? "Created" : "Overwrote"} entity "${result.name}" → ${result.filePath}`,
			);
		}
		case "config": {
			const name = requireArg(args, 0, "name");
			const updates: Array<{ key: string; value: string }> = [];
			for (const kv of flags.set ?? []) {
				const eq = kv.indexOf("=");
				if (eq <= 0) throw new EntityCommandUsageError(`--set expects key=value, got "${kv}"`);
				updates.push({ key: kv.slice(0, eq).trim(), value: kv.slice(eq + 1) });
			}
			// Positional `key value` form (single update).
			if (updates.length === 0 && args.length >= 3) {
				updates.push({ key: args[1]!, value: args.slice(2).join(" ") });
			} else if (updates.length === 0 && args.length === 2) {
				// A stray key with no value is a mistake, not a GET — do not silently ignore it.
				throw new EntityCommandUsageError("config expects key=value, --set, or `key value`");
			}
			if (updates.length === 0) {
				// Get: print the current resolved config.
				const config = await deps.resolve(name, { registryRoot });
				return emit(
					deps,
					json,
					config,
					`${name}: ${config.role}, model=${config.model?.join(",") ?? "—"}, bank=${config.memory.bank}, §${config.vaultSection}`,
				);
			}
			const result = await deps.updateRecord(name, updates, { registryRoot });
			return emit(
				deps,
				json,
				{ ...result, updates },
				`Updated "${result.name}" (${updates.map(u => u.key).join(", ")})`,
			);
		}
		case "setup": {
			const report = await deps.runSetup({
				registrySource: flags.registrySource,
				registryRoot: flags.registry,
				vaultLocation: flags.vault,
				force: flags.force,
				registerEndpoints: !flags.noEndpoints,
				warmCache: flags.warmCache,
			});
			if (json) return emit(deps, true, report, "");
			deps.write(`Registry root: ${report.registryRoot}\n`);
			deps.write(`Vault:         ${report.vaultLink} → ${report.vaultLocation}\n`);
			for (const step of report.steps) deps.write(`  [${step.status}] ${step.id}: ${step.detail}\n`);
			deps.write(report.ok ? "Setup OK.\n" : "Setup completed WITH CONFLICTS (see above).\n");
			return;
		}
		default:
			await runRuntimeAction(action, args, flags, deps, json, registryRoot);
	}
}

/** C4 runtime actions — each obtains the broker-backed client lazily. */
async function runRuntimeAction(
	action: string,
	args: string[],
	flags: EntityCommandFlags,
	deps: EntityCommandDeps,
	json: boolean | undefined,
	registryRoot: string | undefined,
): Promise<void> {
	const client = await deps.connectClient();
	try {
		await runRuntimeDispatch(action, args, flags, deps, json, client, registryRoot);
	} finally {
		// One-shot CLI: drop the persistent broker socket so the process exits
		// cleanly (detach-and-return). The detached broker + resident worker
		// keep running independently of this client.
		client.close?.();
	}
}

/** Dispatch one C4 runtime action over an already-connected client. */
async function runRuntimeDispatch(
	action: string,
	args: string[],
	flags: EntityCommandFlags,
	deps: EntityCommandDeps,
	json: boolean | undefined,
	client: EntityRuntimeClient,
	_registryRoot: string | undefined,
): Promise<void> {
	switch (action) {
		case "spawn": {
			const name = requireArg(args, 0, "name");
			const summary = await client.spawn(name, flags.cwd ?? process.cwd());
			return emit(deps, json, summary, `Spawned ${summary.entityName} as ${summary.id}`);
		}
		case "ps":
		case "sessions": {
			const sessions = await client.list();
			if (json) return emit(deps, true, sessions, "");
			if (sessions.length === 0) deps.write("No running sessions.\n");
			for (const s of sessions) deps.write(`${formatSummary(s)}\n`);
			return;
		}
		case "attach": {
			const id = requireArg(args, 0, "id");
			const result = await client.attach(id);
			const s = result.snapshot.summary;
			return emit(
				deps,
				json,
				result,
				`Attached ${s.entityName} (${s.id}) — ${result.snapshot.messageCount} messages, worker ${s.workerState}. Detach with: omp entity detach ${s.id}`,
			);
		}
		case "detach": {
			const id = requireArg(args, 0, "id");
			await client.detach(id);
			return emit(deps, json, { id, detached: true }, `Detached ${id}`);
		}
		case "stop": {
			const id = requireArg(args, 0, "id");
			await client.stop(id);
			return emit(deps, json, { id, stopped: true }, `Stopped ${id}`);
		}
		case "prompt": {
			const id = requireArg(args, 0, "id");
			await client.prompt(id, joinRest(args, 1, "text"));
			return emit(deps, json, { id, ok: true }, `Prompt sent to ${id}`);
		}
		case "steer": {
			const id = requireArg(args, 0, "id");
			await client.steer(id, joinRest(args, 1, "text"));
			return emit(deps, json, { id, ok: true }, `Steer sent to ${id}`);
		}
		case "follow-up":
		case "follow_up": {
			const id = requireArg(args, 0, "id");
			await client.followUp(id, joinRest(args, 1, "text"));
			return emit(deps, json, { id, ok: true }, `Follow-up queued for ${id}`);
		}
		case "send": {
			const target = requireArg(args, 0, "target");
			const receipt = await client.sendMessage(target, joinRest(args, 1, "text"), parseMessageMode(flags.mode));
			return emit(
				deps,
				json,
				receipt,
				`Message to ${receipt.target}: ${receipt.outcome}${receipt.error ? ` (${receipt.error})` : ""}`,
			);
		}
		case "schedule":
			return runScheduleAction(args, flags, deps, json, client);
		case "heartbeat":
			return runHeartbeatAction(args, flags, deps, json, client);
		case "goal":
			return runGoalAction(args, flags, deps, json, client);
		case "autonomous":
			return runAutonomousAction(args, deps, json, flags, client);
		default:
			throw new EntityCommandUsageError(`unknown action "${action}"`);
	}
}

async function runScheduleAction(
	args: string[],
	flags: EntityCommandFlags,
	deps: EntityCommandDeps,
	json: boolean | undefined,
	client: EntityRuntimeClient,
): Promise<void> {
	const sub = requireArg(args, 0, "add|list|cancel");
	switch (sub) {
		case "add": {
			const id = requireArg(args, 1, "id");
			const schedule = requireArg(args, 2, "schedule");
			const prompt = joinRest(args, 3, "prompt");
			const job = await client.scheduleAdd(id, {
				schedule,
				prompt,
				label: flags.label,
				deliveryMode: parseDeliveryMode(flags.delivery),
			});
			return emit(deps, json, job, `Scheduled ${job.id}: ${formatJob(job)}`);
		}
		case "list": {
			const id = requireArg(args, 1, "id");
			const jobs = await client.scheduleList(id, flags.includeInactive);
			if (json) return emit(deps, true, jobs, "");
			if (jobs.length === 0) deps.write("No scheduled jobs.\n");
			for (const j of jobs) deps.write(`${formatJob(j)}\n`);
			return;
		}
		case "cancel": {
			const id = requireArg(args, 1, "id");
			const jobId = requireArg(args, 2, "jobId");
			const cancelled = await client.scheduleCancel(id, jobId);
			return emit(
				deps,
				json,
				{ jobId, cancelled },
				cancelled ? `Cancelled ${jobId}` : `No such active job ${jobId}`,
			);
		}
		default:
			throw new EntityCommandUsageError(`schedule: unknown subcommand "${sub}" (add|list|cancel)`);
	}
}

async function runHeartbeatAction(
	args: string[],
	flags: EntityCommandFlags,
	deps: EntityCommandDeps,
	json: boolean | undefined,
	client: EntityRuntimeClient,
): Promise<void> {
	const sub = requireArg(args, 0, "set|pause|resume|clear");
	const id = requireArg(args, 1, "id");
	switch (sub) {
		case "set": {
			const schedule = requireArg(args, 2, "schedule");
			const instruction = joinRest(args, 3, "instruction");
			const job = await client.heartbeatSet(id, schedule, instruction, parseDeliveryMode(flags.delivery));
			return emit(deps, json, job ?? null, job ? `Heartbeat set: ${formatJob(job)}` : "Heartbeat set");
		}
		case "pause":
			await client.heartbeatPause(id);
			return emit(deps, json, { id, ok: true }, `Heartbeat paused for ${id}`);
		case "resume":
			await client.heartbeatResume(id);
			return emit(deps, json, { id, ok: true }, `Heartbeat resumed for ${id}`);
		case "clear":
			await client.heartbeatClear(id);
			return emit(deps, json, { id, ok: true }, `Heartbeat cleared for ${id}`);
		default:
			throw new EntityCommandUsageError(`heartbeat: unknown subcommand "${sub}" (set|pause|resume|clear)`);
	}
}

async function runGoalAction(
	args: string[],
	flags: EntityCommandFlags,
	deps: EntityCommandDeps,
	json: boolean | undefined,
	client: EntityRuntimeClient,
): Promise<void> {
	const sub = requireArg(args, 0, "set|status|pause|resume|clear");
	const id = requireArg(args, 1, "id");
	const formatGoal = (g: AgentGoalView): string =>
		`goal ${g.status}${g.objective ? ` — "${g.objective}"` : ""} (cont=${g.continuationsUsed}, tokens=${g.tokensUsed}${g.tokenBudget ? `/${g.tokenBudget}` : ""})`;
	switch (sub) {
		case "set": {
			const objective = joinRest(args, 2, "objective");
			const goal = await client.goalSet(id, { objective, tokenBudget: flags.budget });
			return emit(deps, json, goal, `Goal set: ${formatGoal(goal)}`);
		}
		case "status": {
			const status = await client.goalStatus(id);
			return emit(deps, json, status, formatGoal(status));
		}
		case "pause":
			return emit(deps, json, await client.goalPause(id), `Goal paused`);
		case "resume":
			return emit(deps, json, await client.goalResume(id), `Goal resumed`);
		case "clear":
			return emit(deps, json, await client.goalClear(id), `Goal cleared`);
		default:
			throw new EntityCommandUsageError(`goal: unknown subcommand "${sub}" (set|status|pause|resume|clear)`);
	}
}

async function runAutonomousAction(
	args: string[],
	deps: EntityCommandDeps,
	json: boolean | undefined,
	flags: EntityCommandFlags,
	client: EntityRuntimeClient,
): Promise<void> {
	const sub = requireArg(args, 0, "on|off|status");
	const id = requireArg(args, 1, "id");
	const formatAuto = (a: AgentAutonomousView): string =>
		`autonomous ${a.enabled ? "on" : "off"} (cont=${a.continuationsUsed}/${a.limits.maxContinuations}, turns=${a.turnsUsed}/${a.limits.maxTurns}, tokens=${a.tokensUsed}/${a.limits.maxTokens})`;
	switch (sub) {
		case "on": {
			const spec: AgentAutonomousSpec = {
				maxContinuations: flags.maxContinuations,
				maxTurns: flags.maxTurns,
				maxTokens: flags.maxTokens,
				timeoutMs: flags.timeout === undefined ? undefined : flags.timeout * 1000,
			};
			const view = await client.autonomousOn(id, spec);
			return emit(deps, json, view, `Autonomous on: ${formatAuto(view)}`);
		}
		case "off":
			return emit(deps, json, await client.autonomousOff(id), `Autonomous off`);
		case "status": {
			const view = await client.autonomousStatus(id);
			return emit(deps, json, view, formatAuto(view));
		}
		default:
			throw new EntityCommandUsageError(`autonomous: unknown subcommand "${sub}" (on|off|status)`);
	}
}

/** The machine-global broker scope for the persistent entity runtime. */
export const AGENT_RUNTIME_SERVICE = "agent-runtime";

/** Real collaborators: broker-backed C4 client + registry loader/writer + setup. */
export async function defaultEntityDeps(): Promise<EntityCommandDeps> {
	const [{ AgentDaemonClient }, { daemonClientForGlobal }, loader, writer, setup] = await Promise.all([
		import("../launch/agents/agent-daemon-client"),
		import("../launch/client"),
		import("../entity/loader"),
		import("../entity/record-writer"),
		import("../entity/setup"),
	]);
	return {
		write: text => process.stdout.write(text),
		connectClient: async () => new AgentDaemonClient(await daemonClientForGlobal(AGENT_RUNTIME_SERVICE)),
		discover: options => loader.discoverEntities(options),
		resolve: (name, options) => loader.resolveEntityConfig(name, options),
		createRecord: (name, fields, options) => writer.createEntityRecord(name, fields, options),
		updateRecord: (name, updates, options) => writer.updateEntityRecordFields(name, updates, options),
		runSetup: options => setup.runEntitySetup(options),
		readStdin: async () => {
			if (process.stdin.isTTY) return "";
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
			return Buffer.concat(chunks).toString("utf8");
		},
	};
}
