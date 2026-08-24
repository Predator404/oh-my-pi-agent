/**
 * WS7 — operator-surface command dispatch (SPEC §12.7 acceptance: every C4
 * command reachable from the CLI; roster + schedules visible; config editable).
 * Drives `runEntityCommand` with an injected fake broker client + fake registry
 * so dispatch is verified without a live daemon or native deps.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type EntityCommand,
	type EntityCommandDeps,
	EntityCommandUsageError,
	type EntityRuntimeClient,
	runEntityCommand,
} from "@oh-my-pi/pi-coding-agent/cli/entity-cli";

interface Call {
	method: string;
	args: unknown[];
}

function makeHarness() {
	const calls: Call[] = [];
	const out: string[] = [];
	const record = (method: string, ...args: unknown[]): void => {
		calls.push({ method, args });
	};
	const summary = {
		id: "sess-1",
		entityName: "phi",
		cwd: "/w",
		workerState: "ready",
		attached: false,
		busy: false,
		createdAt: "t",
	};
	const job = {
		id: "job-1",
		source: "cron",
		kind: "once",
		status: "active",
		prompt: "p",
		schedule: "in 5m",
		runCount: 0,
	};
	const goal = { active: true, status: "active", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 };
	const auto = {
		enabled: true,
		continuationsUsed: 0,
		turnsUsed: 0,
		tokensUsed: 0,
		limits: { maxContinuations: 50, maxTurns: 100, maxTokens: 1000, timeoutMs: 0 },
	};

	const client: EntityRuntimeClient = {
		spawn: async (name, cwd) => {
			record("spawn", name, cwd);
			return summary as never;
		},
		list: async () => {
			record("list");
			return [summary] as never;
		},
		attach: async id => {
			record("attach", id);
			return { snapshot: { summary, messageCount: 3 } } as never;
		},
		detach: async id => void record("detach", id),
		stop: async id => void record("stop", id),
		prompt: async (id, text) => void record("prompt", id, text),
		steer: async (id, text) => void record("steer", id, text),
		followUp: async (id, text) => void record("followUp", id, text),
		sendMessage: async (target, text, mode) => {
			record("sendMessage", target, text, mode);
			return { target, outcome: "injected", mode } as never;
		},
		scheduleAdd: async (id, spec) => {
			record("scheduleAdd", id, spec);
			return job as never;
		},
		scheduleList: async (id, inc) => {
			record("scheduleList", id, inc);
			return [job] as never;
		},
		scheduleCancel: async (id, jobId) => {
			record("scheduleCancel", id, jobId);
			return true;
		},
		heartbeatSet: async (id, schedule, instruction, delivery) => {
			record("heartbeatSet", id, schedule, instruction, delivery);
			return job as never;
		},
		heartbeatPause: async id => void record("heartbeatPause", id),
		heartbeatResume: async id => void record("heartbeatResume", id),
		heartbeatClear: async id => void record("heartbeatClear", id),
		goalSet: async (id, spec) => {
			record("goalSet", id, spec);
			return goal as never;
		},
		goalStatus: async id => {
			record("goalStatus", id);
			return goal as never;
		},
		goalPause: async id => {
			record("goalPause", id);
			return goal as never;
		},
		goalResume: async id => {
			record("goalResume", id);
			return goal as never;
		},
		goalClear: async id => {
			record("goalClear", id);
			return goal as never;
		},
		autonomousOn: async (id, spec) => {
			record("autonomousOn", id, spec);
			return auto as never;
		},
		autonomousOff: async id => {
			record("autonomousOff", id);
			return auto as never;
		},
		autonomousStatus: async id => {
			record("autonomousStatus", id);
			return auto as never;
		},
		promptAndWait: async (id, text) => {
			record("promptAndWait", id, text);
			const reply = { role: "assistant", content: [{ type: "text", text: `reply:${text}` }] };
			return { messages: [reply], reply, closed: false, timedOut: false } as never;
		},
		daemonStatus: async () => {
			record("daemonStatus");
			return { running: true, pid: 4242, runtimeDir: "/rt", projectDir: "/p", sessions: [summary] } as never;
		},
		daemonShutdown: async force => {
			record("daemonShutdown", force);
			return { stopped: true, wasRunning: true, hadSessions: 1 };
		},
		daemonRestart: async () => {
			record("daemonRestart");
			return { restarted: true, previousPid: 4242, previousSessions: 1, pid: 4343 };
		},
		close: () => record("close"),
	};

	const deps: EntityCommandDeps = {
		write: text => void out.push(text),
		connectClient: async () => client,
		discover: async opts => {
			record("discover", opts);
			return {
				entities: [
					{
						name: "phi",
						role: "persona",
						memory: { bank: "phi", backend: "mnemopi", autoRetain: false },
						vaultSection: "personas/phi",
					},
				],
				errors: [],
			} as never;
		},
		resolve: async (name, opts) => {
			record("resolve", name, opts);
			return {
				name,
				role: "persona",
				description: "d",
				memory: { bank: name, backend: "mnemopi", autoRetain: false },
				vaultSection: `personas/${name}`,
			} as never;
		},
		createRecord: async (name, fields, opts) => {
			record("createRecord", name, fields, opts);
			return { name, filePath: `/r/${name}.md`, created: true };
		},
		updateRecord: async (name, updates, opts) => {
			record("updateRecord", name, updates, opts);
			return { name, filePath: `/r/${name}.md`, created: false };
		},
		runSetup: async opts => {
			record("runSetup", opts);
			return {
				registryRoot: "/r",
				vaultLocation: "/r/vault",
				vaultLink: "/h/vault",
				steps: [],
				ok: true,
				manifestPath: "/a/registries.json",
				registries: [{ id: "oma", root: "/r", visibility: "public" }],
			};
		},
		readStdin: async () => {
			record("readStdin");
			return "";
		},
		loadTranscript: async name => {
			record("loadTranscript", name);
			const messages = [
				{ role: "user", content: "first" },
				{ role: "assistant", content: [{ type: "text", text: "one" }] },
				{ role: "user", content: "second" },
				{ role: "assistant", content: [{ type: "text", text: "two" }] },
			] as unknown as AgentMessage[];
			return { sessionFile: `/s/${name}.jsonl`, messages };
		},
	};

	return { calls, out, deps };
}

const run = (cmd: EntityCommand, deps: EntityCommandDeps) => runEntityCommand(cmd, deps);
const cmd = (action: string, args: string[] = [], flags: EntityCommand["flags"] = {}): EntityCommand => ({
	action,
	args,
	flags,
});

describe("runEntityCommand — runtime C4 surface", () => {
	it("spawn threads name + cwd to the client", async () => {
		const h = makeHarness();
		await run(cmd("spawn", ["phi"], { cwd: "/proj" }), h.deps);
		expect(h.calls).toContainEqual({ method: "spawn", args: ["phi", "/proj"] });
		expect(h.out.join("")).toContain("Spawned");
	});

	it("defaults spawn cwd to the caller's cwd when --cwd is absent", async () => {
		const h = makeHarness();
		await run(cmd("spawn", ["phi"]), h.deps);
		expect(h.calls).toContainEqual({ method: "spawn", args: ["phi", process.cwd()] });
	});

	it("closes the client after a one-shot runtime action so the CLI process can exit", async () => {
		const h = makeHarness();
		await run(cmd("spawn", ["phi"]), h.deps);
		// The persistent broker socket must be released last (detach-and-return),
		// otherwise it pins the event loop and `spawn`/`ps` hang instead of exiting.
		expect(h.calls.at(-1)).toEqual({ method: "close", args: [] });
	});

	it("closes the client even when the action fails", async () => {
		const h = makeHarness();
		await expect(run(cmd("attach", []), h.deps)).rejects.toBeInstanceOf(EntityCommandUsageError);
		expect(h.calls.some(c => c.method === "close")).toBe(true);
	});

	it("ps lists running sessions", async () => {
		const h = makeHarness();
		await run(cmd("ps"), h.deps);
		expect(h.calls.some(c => c.method === "list")).toBe(true);
		expect(h.out.join("")).toContain("sess-1");
	});

	it("attach / detach / stop reach the client by id", async () => {
		const h = makeHarness();
		await run(cmd("attach", ["sess-1"]), h.deps);
		await run(cmd("detach", ["sess-1"]), h.deps);
		await run(cmd("stop", ["sess-1"]), h.deps);
		expect(h.calls.filter(c => ["attach", "detach", "stop"].includes(c.method)).map(c => c.method)).toEqual([
			"attach",
			"detach",
			"stop",
		]);
	});

	it("prompt / steer / follow-up join multi-word text", async () => {
		const h = makeHarness();
		await run(cmd("prompt", ["sess-1", "hello", "world"]), h.deps);
		await run(cmd("steer", ["sess-1", "stop", "now"]), h.deps);
		await run(cmd("follow-up", ["sess-1", "then", "this"]), h.deps);
		expect(h.calls).toContainEqual({ method: "prompt", args: ["sess-1", "hello world"] });
		expect(h.calls).toContainEqual({ method: "steer", args: ["sess-1", "stop now"] });
		expect(h.calls).toContainEqual({ method: "followUp", args: ["sess-1", "then this"] });
	});

	it("send passes the target, text, and --mode", async () => {
		const h = makeHarness();
		await run(cmd("send", ["phi", "ping", "them"], { mode: "steer" }), h.deps);
		expect(h.calls).toContainEqual({ method: "sendMessage", args: ["phi", "ping them", "steer"] });
	});

	it("schedule add/list/cancel dispatch with spec + flags", async () => {
		const h = makeHarness();
		await run(
			cmd("schedule", ["add", "sess-1", "every 5m", "check", "queue"], { label: "L", delivery: "follow_up" }),
			h.deps,
		);
		await run(cmd("schedule", ["list", "sess-1"], { includeInactive: true }), h.deps);
		await run(cmd("schedule", ["cancel", "sess-1", "job-1"]), h.deps);
		const add = h.calls.find(c => c.method === "scheduleAdd")!;
		expect(add.args[1]).toEqual({
			schedule: "every 5m",
			prompt: "check queue",
			label: "L",
			deliveryMode: "follow_up",
		});
		expect(h.calls).toContainEqual({ method: "scheduleList", args: ["sess-1", true] });
		expect(h.calls).toContainEqual({ method: "scheduleCancel", args: ["sess-1", "job-1"] });
	});

	it("heartbeat set/pause/resume/clear dispatch", async () => {
		const h = makeHarness();
		await run(
			cmd("heartbeat", ["set", "sess-1", "every 30m", "review", "the", "queue"], { delivery: "steer" }),
			h.deps,
		);
		await run(cmd("heartbeat", ["pause", "sess-1"]), h.deps);
		await run(cmd("heartbeat", ["resume", "sess-1"]), h.deps);
		await run(cmd("heartbeat", ["clear", "sess-1"]), h.deps);
		expect(h.calls).toContainEqual({
			method: "heartbeatSet",
			args: ["sess-1", "every 30m", "review the queue", "steer"],
		});
		expect(h.calls.map(c => c.method)).toEqual(
			expect.arrayContaining(["heartbeatPause", "heartbeatResume", "heartbeatClear"]),
		);
	});

	it("goal set threads objective + --budget, and status/pause/resume/clear dispatch", async () => {
		const h = makeHarness();
		await run(cmd("goal", ["set", "sess-1", "triage", "issues"], { budget: 200000 }), h.deps);
		await run(cmd("goal", ["status", "sess-1"]), h.deps);
		await run(cmd("goal", ["clear", "sess-1"]), h.deps);
		expect(h.calls).toContainEqual({
			method: "goalSet",
			args: ["sess-1", { objective: "triage issues", tokenBudget: 200000 }],
		});
		expect(h.calls.map(c => c.method)).toEqual(expect.arrayContaining(["goalStatus", "goalClear"]));
	});

	it("autonomous on maps limit flags (timeout seconds → ms), off/status dispatch", async () => {
		const h = makeHarness();
		await run(cmd("autonomous", ["on", "sess-1"], { maxTurns: 10, maxTokens: 5000, timeout: 60 }), h.deps);
		await run(cmd("autonomous", ["off", "sess-1"]), h.deps);
		await run(cmd("autonomous", ["status", "sess-1"]), h.deps);
		const on = h.calls.find(c => c.method === "autonomousOn")!;
		expect(on.args[1]).toEqual({ maxContinuations: undefined, maxTurns: 10, maxTokens: 5000, timeoutMs: 60000 });
		expect(h.calls.map(c => c.method)).toEqual(expect.arrayContaining(["autonomousOff", "autonomousStatus"]));
	});
});

describe("runEntityCommand — registry/config surface", () => {
	it("roster lists defined entities via discover", async () => {
		const h = makeHarness();
		await run(cmd("roster"), h.deps);
		expect(h.calls.some(c => c.method === "discover")).toBe(true);
		expect(h.out.join("")).toContain("phi");
	});

	it("show resolves and prints the entity config", async () => {
		const h = makeHarness();
		await run(cmd("show", ["phi"]), h.deps);
		expect(h.calls).toContainEqual({ method: "resolve", args: ["phi", { registryRoot: undefined }] });
		expect(h.out.join("")).toContain("personas/phi");
	});

	it("create scaffolds a record from flags + stdin prompt", async () => {
		const h = makeHarness();
		await run(
			cmd("create", ["sage"], {
				role: "persona",
				description: "expert",
				prompt: "You are Sage",
				model: "anthropic/opus",
				tools: "read,grep",
			}),
			h.deps,
		);
		const call = h.calls.find(c => c.method === "createRecord")!;
		expect(call.args[0]).toBe("sage");
		expect(call.args[1]).toMatchObject({
			role: "persona",
			description: "expert",
			systemPrompt: "You are Sage",
			model: ["anthropic/opus"],
			tools: ["read", "grep"],
		});
	});

	it("--registry routes a create into the target registry", async () => {
		const h = makeHarness();
		await run(
			cmd("create", ["sage"], { role: "persona", description: "d", prompt: "p", registry: "secret" }),
			h.deps,
		);
		const call = h.calls.find(c => c.method === "createRecord")!;
		expect(call.args[2]).toMatchObject({ registry: "secret" });
	});

	it("create rejects a bad role / missing description", async () => {
		const h = makeHarness();
		expect(
			run(cmd("create", ["x"], { role: "bogus", description: "d", prompt: "p" }), h.deps),
		).rejects.toBeInstanceOf(EntityCommandUsageError);
		expect(run(cmd("create", ["x"], { role: "agent", prompt: "p" }), h.deps)).rejects.toBeInstanceOf(
			EntityCommandUsageError,
		);
	});

	it("config --set parses key=value updates", async () => {
		const h = makeHarness();
		await run(cmd("config", ["phi"], { set: ["model=anthropic/opus", "thinking=high"] }), h.deps);
		const call = h.calls.find(c => c.method === "updateRecord")!;
		expect(call.args[1]).toEqual([
			{ key: "model", value: "anthropic/opus" },
			{ key: "thinking", value: "high" },
		]);
	});

	it("config with no updates resolves + prints current config (get)", async () => {
		const h = makeHarness();
		await run(cmd("config", ["phi"]), h.deps);
		expect(h.calls.some(c => c.method === "resolve")).toBe(true);
		expect(h.calls.some(c => c.method === "updateRecord")).toBe(false);
	});

	it("config positional key value form", async () => {
		const h = makeHarness();
		await run(cmd("config", ["phi", "description", "new", "desc"]), h.deps);
		const call = h.calls.find(c => c.method === "updateRecord")!;
		expect(call.args[1]).toEqual([{ key: "description", value: "new desc" }]);
	});

	it("setup forwards flags to runSetup", async () => {
		const h = makeHarness();
		await run(
			cmd("setup", [], { registrySource: "/repo", vault: "/v", force: true, noEndpoints: true, warmCache: true }),
			h.deps,
		);
		expect(h.calls).toContainEqual({
			method: "runSetup",
			args: [
				{
					registrySource: "/repo",
					registryRoot: undefined,
					vaultLocation: "/v",
					force: true,
					registerEndpoints: false,
					warmCache: true,
				},
			],
		});
	});
});

describe("runEntityCommand — errors + json", () => {
	it("rejects an unknown action", async () => {
		const h = makeHarness();
		expect(run(cmd("frobnicate"), h.deps)).rejects.toBeInstanceOf(EntityCommandUsageError);
	});

	it("rejects a missing required argument", async () => {
		const h = makeHarness();
		expect(run(cmd("prompt", ["sess-1"]), h.deps)).rejects.toBeInstanceOf(EntityCommandUsageError);
		expect(run(cmd("spawn", []), h.deps)).rejects.toBeInstanceOf(EntityCommandUsageError);
	});

	it("rejects a stray config key with no value (does not silently GET)", async () => {
		const h = makeHarness();
		expect(run(cmd("config", ["phi", "model"]), h.deps)).rejects.toBeInstanceOf(EntityCommandUsageError);
		// GET path untouched: no resolve/update happened.
		expect(h.calls.some(c => c.method === "resolve" || c.method === "updateRecord")).toBe(false);
	});

	it("emits JSON when --json is set", async () => {
		const h = makeHarness();
		await run(cmd("spawn", ["phi"], { json: true }), h.deps);
		const parsed = JSON.parse(h.out.join(""));
		expect(parsed.id).toBe("sess-1");
	});
});

describe("runEntityCommand — retrieval ergonomics + daemon lifecycle", () => {
	it("accepts an entity NAME where a session id is expected (prompt)", async () => {
		const h = makeHarness();
		// The live session's entityName is "phi", id "sess-1": passing "phi" resolves to the id.
		await run(cmd("prompt", ["phi", "hi"]), h.deps);
		expect(h.calls).toContainEqual({ method: "prompt", args: ["sess-1", "hi"] });
	});

	it("resolves a unique id prefix to the full active-session id", async () => {
		const h = makeHarness();
		await run(cmd("stop", ["sess"]), h.deps);
		expect(h.calls).toContainEqual({ method: "stop", args: ["sess-1"] });
	});

	it("prompt --wait blocks for the reply and prints the assistant text", async () => {
		const h = makeHarness();
		await run(cmd("prompt", ["sess-1", "ping"], { wait: true }), h.deps);
		expect(h.calls).toContainEqual({ method: "promptAndWait", args: ["sess-1", "ping"] });
		expect(h.out.join("")).toContain("reply:ping");
		// The plain fire-and-forget prompt must NOT also fire.
		expect(h.calls.some(c => c.method === "prompt")).toBe(false);
	});

	it("transcript dumps the entity's turns via loadTranscript", async () => {
		const h = makeHarness();
		await run(cmd("transcript", ["phi"], { last: 5 }), h.deps);
		expect(h.calls).toContainEqual({ method: "loadTranscript", args: ["phi"] });
		expect(h.out.join("")).toContain("phi — last 5 turns");
	});

	it("transcript --json emits the session file and turn slice", async () => {
		const h = makeHarness();
		await run(cmd("transcript", ["phi"], { last: 3, json: true }), h.deps);
		const parsed = JSON.parse(h.out.join(""));
		expect(parsed.entityName).toBe("phi");
		expect(parsed.sessionFile).toBe("/s/phi.jsonl");
		expect(parsed.turnCount).toBe(3);
	});

	it("transcript --last slices to the most recent N turns", async () => {
		const h = makeHarness();
		// The fake transcript has two user turns; --last 1 keeps only the second.
		await run(cmd("transcript", ["phi"], { last: 1, json: true }), h.deps);
		const parsed = JSON.parse(h.out.join(""));
		expect(parsed.turnCount).toBe(1);
		expect(parsed.messages).toHaveLength(2);
		expect(parsed.messages[0].content).toBe("second");
	});

	it("daemon status reports liveness + resident sessions", async () => {
		const h = makeHarness();
		await run(cmd("daemon", ["status"]), h.deps);
		expect(h.calls.some(c => c.method === "daemonStatus")).toBe(true);
		expect(h.out.join("")).toContain("daemon running");
		expect(h.calls.at(-1)).toEqual({ method: "close", args: [] });
	});

	it("daemon shutdown threads --force and reports the outcome", async () => {
		const h = makeHarness();
		await run(cmd("daemon", ["shutdown"], { force: true }), h.deps);
		expect(h.calls).toContainEqual({ method: "daemonShutdown", args: [true] });
		expect(h.out.join("")).toContain("daemon stopped");
	});

	it("daemon restart cycles the broker", async () => {
		const h = makeHarness();
		await run(cmd("daemon", ["restart"]), h.deps);
		expect(h.calls.some(c => c.method === "daemonRestart")).toBe(true);
		expect(h.out.join("")).toContain("daemon restarted");
	});

	it("rejects an unknown daemon subcommand", async () => {
		const h = makeHarness();
		await expect(run(cmd("daemon", ["frob"]), h.deps)).rejects.toBeInstanceOf(EntityCommandUsageError);
	});
});
