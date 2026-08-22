/**
 * Adversarial coverage for the CliProtocol cluster (tester pass, not the dev's
 * happy-path suite). Two seams:
 *
 *  1. CLI dispatch — {@link runEntityCommand}: session-selector resolution edge
 *     cases (ambiguous prefix, unknown name, broker unreachable) and the
 *     `transcript` broker-avoidance contract (an on-disk pointer reads WITHOUT
 *     connecting a broker).
 *  2. Supervisor — {@link AgentSupervisor} `#spawn` fast-fail: a second spawn of
 *     an already-live entity returns `session_already_active` IMMEDIATELY (no
 *     30s handshake), and `--force` stops-then-respawns. Driven with an
 *     in-process fake worker link so the handshake completes deterministically.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type EntityCommand,
	type EntityCommandDeps,
	type EntityRuntimeClient,
	runEntityCommand,
} from "@oh-my-pi/pi-coding-agent/cli/entity-cli";
import { AgentSupervisor } from "@oh-my-pi/pi-coding-agent/launch/agents/agent-supervisor";
import { AgentDaemonClient } from "@oh-my-pi/pi-coding-agent/launch/agents/agent-daemon-client";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import type {
	AgentControlCommandEnvelope,
	AgentControlResult,
} from "@oh-my-pi/pi-coding-agent/launch/agents/control-protocol";
import { AGENT_CONTROL_PROTOCOL_INFO } from "@oh-my-pi/pi-coding-agent/launch/agents/control-protocol";
import type {
	BrokerSideLink,
	BrokerToWorker,
	WorkerToBroker,
} from "@oh-my-pi/pi-coding-agent/launch/agents/worker-transport";
import type { WorkerSpawnRequest } from "@oh-my-pi/pi-coding-agent/launch/agents/agent-supervisor";

// ---------------------------------------------------------------------------
// CLI dispatch harness
// ---------------------------------------------------------------------------

interface Call {
	method: string;
	args: unknown[];
}

/** A recording EntityRuntimeClient. Only the overridden methods are callable;
 *  anything else throws so an accidental broker round-trip is loud. */
function stubClient(impl: Partial<EntityRuntimeClient>): { client: EntityRuntimeClient; calls: Call[] } {
	const calls: Call[] = [];
	const client = new Proxy(
		{},
		{
			get(_t, prop: string) {
				if (prop === "then") return undefined; // never look thenable
				return (...args: unknown[]) => {
					calls.push({ method: prop, args });
					const fn = (impl as Record<string, unknown>)[prop];
					if (typeof fn !== "function") throw new Error(`unexpected client.${prop}()`);
					return (fn as (...a: unknown[]) => unknown)(...args);
				};
			},
		},
	) as unknown as EntityRuntimeClient;
	return { client, calls };
}

interface HarnessOptions {
	client?: Partial<EntityRuntimeClient>;
	transcripts?: Record<string, AgentMessage[]>;
}

function makeDeps(opts: HarnessOptions = {}): {
	deps: EntityCommandDeps;
	out: string[];
	clientCalls: Call[];
	connectCount: () => number;
} {
	const out: string[] = [];
	let connects = 0;
	const clientImpl: Partial<EntityRuntimeClient> = { close: () => {}, ...opts.client };
	const { client, calls } = stubClient(clientImpl);
	const deps = {
		write: (t: string) => void out.push(t),
		connectClient: async () => {
			connects++;
			return client;
		},
		loadTranscript: async (name: string) => {
			const messages = opts.transcripts?.[name];
			if (!messages) return undefined;
			return { sessionFile: `/s/${name}.jsonl`, messages };
		},
	} as unknown as EntityCommandDeps;
	return { deps, out, clientCalls: calls, connectCount: () => connects };
}

const cmd = (action: string, args: string[] = [], flags: EntityCommand["flags"] = {}): EntityCommand => ({
	action,
	args,
	flags,
});

const session = (id: string, entityName: string) =>
	({
		id,
		entityName,
		cwd: "/w",
		workerState: "ready",
		attached: false,
		busy: false,
		createdAt: "t",
	}) as never;

describe("resolveSessionId — no silent wrong-session", () => {
	it("passes an AMBIGUOUS id prefix through verbatim (server disambiguates)", async () => {
		// Two live ids share the prefix "sess". A silent pick would be a data-loss bug.
		const { deps, clientCalls } = makeDeps({
			client: {
				list: async () => [session("sess-abc", "alpha"), session("sess-xyz", "beta")],
				stop: async () => {},
			},
		});
		await runEntityCommand(cmd("stop", ["sess"]), deps);
		const stop = clientCalls.find(c => c.method === "stop");
		expect(stop?.args[0]).toBe("sess"); // NOT "sess-abc"
	});

	it("passes an UNKNOWN name/id through verbatim", async () => {
		const { deps, clientCalls } = makeDeps({
			client: { list: async () => [session("sess-1", "phi")], stop: async () => {} },
		});
		await runEntityCommand(cmd("stop", ["ghost"]), deps);
		expect(clientCalls.find(c => c.method === "stop")?.args[0]).toBe("ghost");
	});

	it("falls back to the raw selector when the broker list() throws", async () => {
		const { deps, clientCalls } = makeDeps({
			client: {
				list: async () => {
					throw new Error("broker unreachable");
				},
				stop: async () => {},
			},
		});
		await runEntityCommand(cmd("stop", ["anything"]), deps);
		expect(clientCalls.find(c => c.method === "stop")?.args[0]).toBe("anything");
	});

	it("prefers an exact entityName match over a prefix collision", async () => {
		// "beta" is an exact name; "sess-1" also exists. Name must win, not fall to prefix logic.
		const { deps, clientCalls } = makeDeps({
			client: {
				list: async () => [session("sess-1", "alpha"), session("sess-2", "beta")],
				prompt: async () => {},
			},
		});
		await runEntityCommand(cmd("prompt", ["beta", "hi"]), deps);
		expect(clientCalls.find(c => c.method === "prompt")?.args[0]).toBe("sess-2");
	});
});

const userMsg = (text: string): AgentMessage => ({ role: "user", content: text }) as never;
const asstMsg = (text: string): AgentMessage =>
	({ role: "assistant", content: [{ type: "text", text }] }) as never;

describe("transcript — reads on-disk, avoids the broker", () => {
	it("dumps an on-disk entity WITHOUT connecting a broker", async () => {
		const { deps, out, clientCalls, connectCount } = makeDeps({
			transcripts: { phi: [userMsg("hello"), asstMsg("world")] },
		});
		await runEntityCommand(cmd("transcript", ["phi"], { last: 5 }), deps);
		expect(connectCount()).toBe(0); // pointer-file path: no daemon spawned
		expect(clientCalls).toHaveLength(0);
		expect(out.join("")).toContain("phi — last 5 turns");
	});

	it("emits a clean 'No transcript' for an unknown entity and still closes the client", async () => {
		const { deps, out, clientCalls, connectCount } = makeDeps({
			transcripts: {}, // nothing on disk
			client: { list: async () => [] }, // broker knows nothing either
		});
		await runEntityCommand(cmd("transcript", ["ghost"]), deps);
		expect(out.join("")).toContain('No transcript for "ghost".');
		expect(connectCount()).toBe(1); // consulted broker once to map id->name
		expect(clientCalls.at(-1)?.method).toBe("close"); // socket released
	});

	it("maps a live id prefix to its entity name via the broker when not on disk", async () => {
		const { deps, out, connectCount } = makeDeps({
			transcripts: { phi: [userMsg("q"), asstMsg("a")] }, // keyed by NAME, not id
			client: { list: async () => [session("sess-1", "phi")] },
		});
		await runEntityCommand(cmd("transcript", ["sess-1"]), deps);
		expect(connectCount()).toBe(1);
		expect(out.join("")).toContain("phi — last"); // resolved id -> name -> transcript
	});

	it("--json slices at user-message turn boundaries and reports the documented shape", async () => {
		const messages = [
			userMsg("u1"),
			asstMsg("a1"),
			userMsg("u2"),
			asstMsg("a2a"),
			asstMsg("a2b"),
			userMsg("u3"),
			asstMsg("a3"),
		];
		const { deps, out } = makeDeps({ transcripts: { phi: messages } });
		await runEntityCommand(cmd("transcript", ["phi"], { last: 2, json: true }), deps);
		const parsed = JSON.parse(out.join(""));
		expect(parsed.entityName).toBe("phi");
		expect(parsed.sessionFile).toBe("/s/phi.jsonl");
		expect(parsed.turnCount).toBe(2);
		// last 2 turns => from the 2nd-from-last user message (u2) to the end.
		expect(parsed.messages[0].role).toBe("user");
		expect(parsed.messages[0].content).toBe("u2");
		expect(parsed.messages).toHaveLength(5); // u2,a2a,a2b,u3,a3
	});
});

// ---------------------------------------------------------------------------
// Supervisor #spawn fast-fail
// ---------------------------------------------------------------------------

/** In-process broker-side link that completes the auth+ready handshake for a
 *  fake worker, and acknowledges shutdown by closing. */
class FakeLink implements BrokerSideLink {
	#onMsg?: (m: WorkerToBroker, p: Buffer) => void;
	#onClose?: (e?: Error) => void;
	readonly sent: BrokerToWorker[] = [];
	closed = false;
	constructor(private readonly req: WorkerSpawnRequest) {}

	send(message: BrokerToWorker): void {
		this.sent.push(message);
		if (message.type === "auth_ok") {
			queueMicrotask(() => this.#onMsg?.({ type: "lifecycle", state: "ready" }, Buffer.alloc(0)));
		} else if (message.type === "shutdown") {
			queueMicrotask(() => this.#onClose?.());
		}
	}
	onMessage(handler: (m: WorkerToBroker, p: Buffer) => void): void {
		this.#onMsg = handler;
		queueMicrotask(() =>
			this.#onMsg?.(
				{
					type: "auth",
					token: this.req.token,
					generation: this.req.generation,
					activeSessionId: this.req.activeSessionId,
					entityName: this.req.entityName,
					cwd: this.req.cwd,
				},
				Buffer.alloc(0),
			),
		);
	}
	onClose(handler: (e?: Error) => void): void {
		this.#onClose = handler;
	}
	close(): void {
		this.closed = true;
	}
}

function makeSupervisor() {
	const requests: WorkerSpawnRequest[] = [];
	const links: FakeLink[] = [];
	let n = 0;
	const supervisor = new AgentSupervisor({
		spawner: {
			spawn: async (req: WorkerSpawnRequest) => {
				requests.push(req);
				const link = new FakeLink(req);
				links.push(link);
				return { link };
			},
		},
		handshakeTimeoutMs: 2_000,
		newId: () => `id-${++n}`,
	});
	const client = { id: "c1" as never, capabilities: [], sendEvent: () => {} };
	const spawn = (entityName: string, cwd?: string, force?: boolean): Promise<AgentControlResult> => {
		const envelope: AgentControlCommandEnvelope = {
			type: "command",
			id: `cmd-${entityName}-${force ? "f" : "n"}-${Math.random()}`,
			protocol: AGENT_CONTROL_PROTOCOL_INFO,
			clientId: "c1" as never,
			command: { type: "spawn", entityName, cwd, force },
		};
		return supervisor.handle(envelope, client);
	};
	return { supervisor, requests, links, spawn };
}

describe("AgentSupervisor #spawn — fast-fail on an already-live entity", () => {
	it("first spawn succeeds; second spawn returns session_already_active IMMEDIATELY", async () => {
		const { spawn, requests } = makeSupervisor();
		const first = await spawn("phi", "/work/a");
		expect(first.ok).toBe(true);
		expect(requests).toHaveLength(1);

		const started = Date.now();
		const second = await spawn("phi", "/work/b");
		const elapsed = Date.now() - started;

		expect(second.ok).toBe(false);
		if (second.ok === false) {
			expect(second.error.code).toBe("session_already_active");
			expect(second.error.message).toContain("phi");
			expect(second.error.message).toContain("--force");
			expect(second.error.sessionPath).toBe("/work/a"); // the live cwd
		}
		expect(requests).toHaveLength(1); // NO second worker was spawned
		expect(elapsed).toBeLessThan(1_000); // nowhere near the 30s handshake ceiling
	});

	it("--force stops the live worker then spawns a fresh one", async () => {
		const { spawn, requests, links } = makeSupervisor();
		const first = await spawn("phi", "/work/a");
		expect(first.ok).toBe(true);

		const forced = await spawn("phi", "/work/b", true);
		expect(forced.ok).toBe(true);
		if (forced.ok) expect(forced.type).toBe("spawn");

		expect(requests).toHaveLength(2); // relocated: a real second spawn happened
		expect(requests[1]?.cwd).toBe("/work/b");
		expect(links[0]?.closed).toBe(true); // the original worker was stopped
		// The old worker got a graceful C4 shutdown, not a raw kill.
		expect(links[0]?.sent.some(m => m.type === "shutdown")).toBe(true);
	});

	it("a spawn after the entity is stopped succeeds again (record cleared)", async () => {
		const { supervisor, spawn, requests } = makeSupervisor();
		const first = await spawn("phi", "/work/a");
		expect(first.ok).toBe(true);
		const id = first.type === "spawn" && first.ok ? first.id : "";
		await supervisor.handle(
			{
				type: "command",
				id: "stop-1",
				protocol: AGENT_CONTROL_PROTOCOL_INFO,
				clientId: "c1" as never,
				command: { type: "stop", id: id as never },
			},
			{ id: "c1" as never, capabilities: [], sendEvent: () => {} },
		);
		const again = await spawn("phi", "/work/a");
		expect(again.ok).toBe(true);
		expect(requests).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// AgentDaemonClient.promptAndWait — event-loop turn tracking
// ---------------------------------------------------------------------------

/** Fake broker that answers agent commands and drives the event stream from a
 *  synchronous `script` run while the `prompt` command is handled — so
 *  promptAndWait's busy→message→idle handling is exercised deterministically
 *  (the CLI suite stubs promptAndWait wholesale and never runs this logic). */
class FakeBroker implements DaemonBrokerClient {
	readonly projectDir = "/p";
	readonly runtimeDir = "/rt";
	#sink?: (envelope: never) => void;
	readonly commands: string[] = [];
	/** Emits the woken turn's events; invoked synchronously on `prompt`. */
	script?: (emit: (event: unknown) => void) => void;

	async request(operation: { op: string; envelope?: { command: { type: string } } }): Promise<never> {
		if (operation.op !== "agent" || !operation.envelope) return { op: operation.op } as never;
		const type = operation.envelope.command.type;
		this.commands.push(type);
		if (type === "prompt") this.script?.(event => this.#sink?.({ event } as never));
		const response = type === "attach" ? { type, ok: true, result: {} } : { type, ok: true };
		return { op: "agent", response } as never;
	}
	onAgentEvent(_owner: string, sink: (envelope: never) => void): () => void {
		this.#sink = sink;
		return () => {
			this.#sink = undefined;
		};
	}
	get subscribed(): boolean {
		return this.#sink !== undefined;
	}
	close(): void {}
	onCompletion(): () => void {
		return () => {};
	}
}

describe("AgentDaemonClient.promptAndWait — returns only after the woken turn ends", () => {
	it("resolves on idle with the LAST assistant message as the reply", async () => {
		const broker = new FakeBroker();
		broker.script = emit => {
			emit({ kind: "status", busy: true });
			emit({ kind: "message", message: asstMsg("first") });
			emit({ kind: "message", message: asstMsg("second") });
			emit({ kind: "status", busy: false });
		};
		const client = new AgentDaemonClient(broker, "c1");
		const result = await client.promptAndWait("sess-1" as never, "hi");
		expect(result.messages).toHaveLength(2);
		const firstBlock = result.reply?.role === "assistant" ? result.reply.content[0] : undefined;
		expect(firstBlock && "text" in firstBlock && firstBlock.text).toBe("second");
		expect(result.closed).toBe(false);
		expect(result.timedOut).toBe(false);
		// attach + prompt happened, and a best-effort detach on a still-open session.
		expect(broker.commands).toEqual(["attach", "prompt", "detach"]);
		expect(broker.subscribed).toBe(false); // unsubscribed on completion
	});

	it("reports closed and skips detach when the session closes mid-turn", async () => {
		const broker = new FakeBroker();
		broker.script = emit => {
			emit({ kind: "status", busy: true });
			emit({ kind: "message", message: asstMsg("partial") });
			emit({ kind: "closed", reason: "failed" });
		};
		const client = new AgentDaemonClient(broker, "c1");
		const result = await client.promptAndWait("sess-1" as never, "hi");
		expect(result.closed).toBe(true);
		expect(result.messages).toHaveLength(1);
		expect(broker.commands).toEqual(["attach", "prompt"]); // no detach after close
	});

	it("reports timedOut when the wait ceiling elapses before idle", async () => {
		// Exercises promptAndWait's OWN wait-ceiling timer against the real clock;
		// there is no injection seam for it, so a short real delay is deliberate.
		const broker = new FakeBroker();
		broker.script = emit => emit({ kind: "status", busy: true }); // busy, never idle
		const client = new AgentDaemonClient(broker, "c1");
		const result = await client.promptAndWait("sess-1" as never, "hi", { timeoutMs: 20 });
		expect(result.timedOut).toBe(true);
		expect(result.closed).toBe(false);
		expect(broker.commands).toContain("detach"); // best-effort detach after timeout
	});
});
