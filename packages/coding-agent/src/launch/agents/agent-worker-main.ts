/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * Resident-worker process bootstrap (SPEC §8.1).
 *
 * Runs inside a spawned worker process (selected by {@link AGENT_WORKER_ARG}).
 * It resolves the entity record on demand (the lazy-load site), acquires the
 * session lease, opens/creates the entity's persistent AgentSession with OMP's
 * normal factory (tool surface untouched), connects back to the supervisor over
 * the private socket, and runs the {@link AgentWorker} runtime until a clean C4
 * stop. OS signals are routed to the same clean-stop path (never a raw
 * session-signal dispose — graft risk #2).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import type { SourceMeta } from "../../capability/types";
import { resolveEntityConfig } from "../../entity/loader";
import { buildEntityMcpServers, ENTITY_MCP_SERVER_NAMES } from "../../entity/mcp-wiring";
import type { ResolvedEntityConfig } from "../../entity/schema";
import { buildSkillPromptMessage } from "../../extensibility/skills";
import { callTool } from "../../mcp/client";
import { MCPManager } from "../../mcp/manager";
import type { MCPServerConfig } from "../../mcp/types";
import { createAgentSession } from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../../session/messages";
import { SessionManager } from "../../session/session-manager";
import { AgentWorker } from "./agent-worker";
import { AgentSessionResidentSession } from "./resident-session";
import { acquireSessionLease, SessionAlreadyActiveError } from "./session-lease";
import { ResidentScheduling } from "./worker-scheduling";
import {
	AGENT_WORKER_ACTIVE_SESSION_ID_ENV,
	AGENT_WORKER_CWD_ENV,
	AGENT_WORKER_ENDPOINT_ENV,
	AGENT_WORKER_ENTITY_ENV,
	AGENT_WORKER_GENERATION_ENV,
	AGENT_WORKER_SESSION_FILE_ENV,
	AGENT_WORKER_TOKEN_ENV,
	type BrokerToWorker,
	SocketWorkerLink,
	type WorkerToBroker,
} from "./worker-transport";

function required(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key];
	if (!value) throw new Error(`Missing required worker env: ${key}`);
	return value;
}

function entityHome(entityName: string): string {
	return join(getAgentDir(), "entities", entityName);
}

function sessionPointerPath(entityName: string): string {
	return join(entityHome(entityName), ".session-pointer");
}

/** Resolve the entity's persistent session file: env override, prior pointer, or a fresh file. */
function resolveSessionFile(entityName: string, cwd: string, env: NodeJS.ProcessEnv): string {
	const override = env[AGENT_WORKER_SESSION_FILE_ENV];
	if (override) return override;
	const pointer = sessionPointerPath(entityName);
	if (existsSync(pointer)) {
		const prior = readFileSync(pointer, "utf8").trim();
		if (prior && existsSync(prior)) return prior;
	}
	const fresh = SessionManager.createEmptySessionFile(cwd);
	mkdirSync(entityHome(entityName), { recursive: true });
	writeFileSync(pointer, fresh);
	return fresh;
}

async function connectWorkerSocket(endpoint: string): Promise<net.Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.connect(endpoint);
	socket.once("connect", () => resolve(socket));
	socket.once("error", reject);
	return promise;
}

/** Compose + connect the entity's memory + vault MCP servers (C2/C3) for this worker. */
export async function buildEntityMcpManager(
	config: ResolvedEntityConfig,
	cwd: string,
): Promise<MCPManager | undefined> {
	let servers: Record<string, MCPServerConfig>;
	try {
		servers = buildEntityMcpServers(config);
	} catch (error) {
		logger.warn("entity MCP wiring failed", { error: error instanceof Error ? error.message : String(error) });
		return undefined;
	}
	const names = Object.keys(servers);
	if (names.length === 0) return undefined;
	const source: SourceMeta = {
		provider: "omp.daemon.entity",
		providerName: "Entity",
		path: config.source.filePath,
		level: "user",
	};
	const sources: Record<string, SourceMeta> = {};
	for (const name of names) sources[name] = source;
	const manager = new MCPManager(cwd, null);
	await manager.connectServers(servers, sources);
	return manager;
}

/** Flatten a message's text content blocks. */
function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (block.type === "text") text += block.text;
	}
	return text.trim();
}

/** The last user+assistant exchange as one episodic memory ("User: …\n\nAssistant: …"). */
function extractLastUserAssistantTurn(messages: readonly AgentMessage[]): string | undefined {
	let assistantIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			assistantIndex = i;
			break;
		}
	}
	if (assistantIndex < 0) return undefined;
	const assistant = messageText(messages[assistantIndex]);
	let user = "";
	for (let i = assistantIndex - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			user = messageText(messages[i]);
			break;
		}
	}
	if (!assistant && !user) return undefined;
	return `User: ${user}\n\nAssistant: ${assistant}`;
}

/** Inject the entity's autoload skills into context (C1 autoloadSkills; P3). */
export async function applyAutoloadSkills(
	session: AgentSession,
	entityName: string,
	skillNames: readonly string[] | undefined,
): Promise<void> {
	if (!skillNames?.length) return;
	const skillsByName = new Map(session.skills.map(skill => [skill.name, skill]));
	for (const name of skillNames) {
		const skill = skillsByName.get(name);
		if (!skill) {
			logger.warn("autoload skill not found", { entityName, skill: name });
			continue;
		}
		const { message } = await buildSkillPromptMessage(skill, "", "autoload");
		await session.sendCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: message,
				display: false,
				details: { name: skill.name, path: skill.filePath },
			},
			{ triggerTurn: false },
		);
	}
}

/**
 * Arm agent-tier episodic auto-retain (SPEC §4.2). On each turn-end the last
 * user+assistant pair is retained to the entity's bank via the memory `retain`
 * tool with mode:"auto" (WS3's server enforces retention policy; persona banks
 * self-reject). No-op when autoRetain is false or no memory server is connected.
 * Returns an unsubscribe.
 */
export function armEpisodicAutoRetain(
	session: AgentSession,
	entityName: string,
	mcpManager: MCPManager | undefined,
	autoRetain: boolean,
): () => void {
	if (!autoRetain || !mcpManager) return () => {};
	const manager = mcpManager;
	let lastRetained = "";
	return session.subscribeRunState(state => {
		if (state !== "idle") return;
		const memory = extractLastUserAssistantTurn(session.messages);
		if (!memory || memory === lastRetained) return;
		lastRetained = memory;
		const connection = manager.getConnection(ENTITY_MCP_SERVER_NAMES.memory);
		if (!connection) return;
		void callTool(connection, "retain", { memory, mode: "auto" }).catch(error =>
			logger.warn("auto-retain failed", {
				entityName,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	});
}

/** Boot the resident worker from its process environment. Resolves when the worker stops. */
export async function startAgentWorkerFromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const entityName = required(env, AGENT_WORKER_ENTITY_ENV);
	const token = required(env, AGENT_WORKER_TOKEN_ENV);
	const generation = required(env, AGENT_WORKER_GENERATION_ENV);
	const activeSessionId = required(env, AGENT_WORKER_ACTIVE_SESSION_ID_ENV);
	const endpoint = required(env, AGENT_WORKER_ENDPOINT_ENV);
	const cwdOverride = env[AGENT_WORKER_CWD_ENV];

	const config = await resolveEntityConfig(entityName, cwdOverride ? { cwd: cwdOverride } : undefined);
	const cwd = config.cwd ?? entityHome(entityName);
	mkdirSync(cwd, { recursive: true });

	const sessionFile = resolveSessionFile(entityName, cwd, env);
	let lease: ReturnType<typeof acquireSessionLease>;
	try {
		lease = acquireSessionLease(sessionFile, getAgentDir(), { ownerId: activeSessionId });
	} catch (error) {
		if (error instanceof SessionAlreadyActiveError) {
			logger.error("resident worker aborting: session already active", { entityName, sessionFile });
			process.exit(2);
		}
		throw error;
	}

	const sessionManager = SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, getAgentDir()));
	await sessionManager.setSessionFile(sessionFile);

	// Bind the entity's C2 memory (bank) + C3 vault (section) MCP servers so a
	// spawned entity has recall/retain + scoped vault tools (P1 integration fix).
	const mcpManager = await buildEntityMcpManager(config, cwd);

	const { session } = await createAgentSession({
		cwd,
		agentDir: getAgentDir(),
		sessionManager,
		customSystemPrompt: config.systemPrompt,
		modelPattern: config.model,
		thinkingLevel: config.thinkingLevel,
		toolNames: config.tools,
		agentId: activeSessionId,
		agentDisplayName: entityName,
		mcpManager,
	});

	const resident = new AgentSessionResidentSession(session, activeSessionId);
	const scheduling = new ResidentScheduling(resident);
	const socket = await connectWorkerSocket(endpoint);
	const link = new SocketWorkerLink<WorkerToBroker, BrokerToWorker>(socket);

	await applyAutoloadSkills(session, entityName, config.autoloadSkills);

	const unsubscribeRetain = armEpisodicAutoRetain(session, entityName, mcpManager, config.memory.autoRetain);

	const stopped = Promise.withResolvers<void>();
	const worker = new AgentWorker({
		link,
		session: resident,
		scheduling,
		entityName,
		cwd,
		token,
		generation,
		onStopped: async () => {
			unsubscribeRetain?.();
			if (mcpManager) await mcpManager.disconnectAll();
			lease.release();
			stopped.resolve();
		},
	});

	const onSignal = () => void worker.stop("signal");
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);

	await worker.start();
	await stopped.promise;
	process.off("SIGTERM", onSignal);
	process.off("SIGINT", onSignal);
}
