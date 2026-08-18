import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BankStore } from "@oh-my-pi/pi-coding-agent/memory-mcp/bank-store";
import { BankPolicyRegistry } from "@oh-my-pi/pi-coding-agent/memory-mcp/policy";
import {
	type JsonRpcRequest,
	type JsonRpcResponse,
	MemoryMcpServer,
} from "@oh-my-pi/pi-coding-agent/memory-mcp/server";
import { handleToolCall, RetentionPolicyError, type ToolContext } from "@oh-my-pi/pi-coding-agent/memory-mcp/tools";
import { isRecord } from "@oh-my-pi/pi-utils";

// --- fixtures -------------------------------------------------------------
// One agent entity (episodic, autoRetain:true) and one persona entity
// (curated-only, autoRetain:false), each bound to a distinct bank.

const AGENT_RECORD = `---
name: scribe
description: Test agent entity — episodic, auto-retaining.
role: agent
memory:
  backend: mnemopi
  bank: agent-bank
  autoRetain: true
vaultSection: agents/scribe
---
Scribe is a generalist test agent.
`;

const PERSONA_RECORD = `---
name: sage
description: Test persona entity — curated-only lessons.
role: persona
memory:
  backend: mnemopi
  bank: persona-bank
  autoRetain: false
vaultSection: personas/sage
---
Sage is a narrow-domain test persona.
`;

let workRoot: string;
let dataDir: string;
let registryRoot: string;

beforeAll(() => {
	workRoot = mkdtempSync(join(tmpdir(), "omp-memory-mcp-"));
	dataDir = join(workRoot, "data");
	registryRoot = join(workRoot, "registry");
	const entitiesDir = join(registryRoot, "entities");
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(entitiesDir, { recursive: true });
	writeFileSync(join(entitiesDir, "scribe.md"), AGENT_RECORD);
	writeFileSync(join(entitiesDir, "sage.md"), PERSONA_RECORD);
});

afterAll(() => {
	if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

function newStore(): BankStore {
	return new BankStore({ noEmbeddings: true, dataDir });
}

function contentsOf(results: readonly { content: string }[]): string {
	return results.map(r => r.content).join(" ");
}

describe("BankStore — multi-bank isolation and concurrency", () => {
	it("addresses two distinct banks concurrently from one running context, scoped independently", async () => {
		const store = newStore();
		try {
			// Two entities retain into distinct banks concurrently — one context.
			const [agentId, personaId] = await Promise.all([
				Promise.resolve(store.retain("agent-bank", "kingfisher migration patterns over the estuary")),
				Promise.resolve(store.retain("persona-bank", "sourdough fermentation timing at altitude")),
			]);
			expect(agentId).toBeTruthy();
			expect(personaId).toBeTruthy();

			// Both banks have live, independent connections in one store.
			expect(store.openBanks().sort()).toEqual(["agent-bank", "persona-bank"]);

			// Concurrent recall against distinct banks returns only that bank's data.
			const [agentHits, personaHits] = await Promise.all([
				store.recall("agent-bank", "kingfisher"),
				store.recall("persona-bank", "sourdough"),
			]);
			expect(contentsOf(agentHits)).toContain("kingfisher");
			expect(contentsOf(agentHits)).not.toContain("sourdough");
			expect(contentsOf(personaHits)).toContain("sourdough");
			expect(contentsOf(personaHits)).not.toContain("kingfisher");

			// Cross-bank query finds nothing (scope really is per-bank).
			const crossed = await store.recall("agent-bank", "sourdough");
			expect(contentsOf(crossed)).not.toContain("sourdough");
		} finally {
			store.close();
		}
	});

	it("keeps both bank connections usable after interleaved writes (no cross-close)", async () => {
		const store = newStore();
		try {
			store.retain("agent-bank", "osprey nest survey notes");
			store.retain("persona-bank", "espresso extraction ratio lesson");
			store.retain("agent-bank", "heron feeding ground map");
			// After touching persona-bank between agent-bank writes, agent-bank still works.
			expect(contentsOf(await store.recall("agent-bank", "osprey"))).toContain("osprey");
			expect(contentsOf(await store.recall("persona-bank", "espresso"))).toContain("espresso");
		} finally {
			store.close();
		}
	});

	it("does not provision a bank on a read-shaped op (recall/forget)", async () => {
		const store = newStore();
		try {
			// A never-written bank must read empty, not silently materialize.
			expect(await store.recall("ghost-bank", "anything")).toEqual([]);
			expect(store.forget("ghost-bank", "nope")).toBe(false);
			expect(store.openBanks()).not.toContain("ghost-bank");
			// The bank was not created on disk either.
			const probe = newStore();
			try {
				expect(await probe.recall("ghost-bank", "anything")).toEqual([]);
			} finally {
				probe.close();
			}
		} finally {
			store.close();
		}
	});
});

describe("retention policy — enforced at the write path", () => {
	function ctx(store: BankStore): ToolContext {
		return { store, policy: new BankPolicyRegistry({ registryRoot }) };
	}

	it("rejects auto-retain on a curated-only (persona) bank", async () => {
		const store = newStore();
		try {
			const call = handleToolCall(
				"retain",
				{ bank: "persona-bank", memory: "auto captured turn", mode: "auto" },
				ctx(store),
			);
			await expect(call).rejects.toBeInstanceOf(RetentionPolicyError);
			await expect(call).rejects.toThrow(/curated-only/);
			// Nothing was written.
			expect((await store.recall("persona-bank", "captured")).length).toBe(0);
		} finally {
			store.close();
		}
	});

	it("allows deliberate retain on a persona bank (curated lesson)", async () => {
		const store = newStore();
		try {
			const result = await handleToolCall(
				"retain",
				{ bank: "persona-bank", memory: "verified harness contract lesson", mode: "deliberate" },
				ctx(store),
			);
			expect(result.mode).toBe("deliberate");
			expect(result.id).toBeTruthy();
			expect(contentsOf(await store.recall("persona-bank", "harness"))).toContain("harness");
		} finally {
			store.close();
		}
	});

	it("defaults mode to deliberate when omitted, so a plain retain always lands", async () => {
		const store = newStore();
		try {
			const result = await handleToolCall(
				"retain",
				{ bank: "persona-bank", memory: "default-mode curated note" },
				ctx(store),
			);
			expect(result.mode).toBe("deliberate");
			expect(result.id).toBeTruthy();
		} finally {
			store.close();
		}
	});

	it("allows auto-retain on an agent bank (episodic tier)", async () => {
		const store = newStore();
		try {
			const result = await handleToolCall(
				"retain",
				{ bank: "agent-bank", memory: "episodic turn about the estuary", mode: "auto" },
				ctx(store),
			);
			expect(result.mode).toBe("auto");
			expect(result.id).toBeTruthy();
		} finally {
			store.close();
		}
	});

	it("rejects auto-retain on an unknown bank (no policy permits it)", async () => {
		const store = newStore();
		try {
			const call = handleToolCall(
				"retain",
				{ bank: "unbound-bank", memory: "orphan auto write", mode: "auto" },
				ctx(store),
			);
			await expect(call).rejects.toBeInstanceOf(RetentionPolicyError);
		} finally {
			store.close();
		}
	});
});

describe("policy registry — bank binding resolved from C1 records", () => {
	it("aggregates memory.autoRetain per bank from the entity registry", async () => {
		const policy = new BankPolicyRegistry({ registryRoot });
		expect(await policy.canAutoRetain("agent-bank")).toBe(true);
		expect(await policy.canAutoRetain("persona-bank")).toBe(false);
		expect(await policy.canAutoRetain("unbound-bank")).toBe(false);
		expect((await policy.policy("agent-bank"))?.entities).toEqual(["scribe"]);
		expect((await policy.policy("persona-bank"))?.entities).toEqual(["sage"]);
	});

	it("distinguishes curated-only, unbound-bank, and registry-unresolved denials", async () => {
		const bound = new BankPolicyRegistry({ registryRoot });
		const personaDenial = await bound.decideAutoRetain("persona-bank");
		expect(personaDenial.allowed).toBe(false);
		if (!personaDenial.allowed) expect(personaDenial.reason).toBe("curated-only");
		const unboundDenial = await bound.decideAutoRetain("some-other-bank");
		expect(unboundDenial.allowed).toBe(false);
		if (!unboundDenial.allowed) expect(unboundDenial.reason).toBe("unbound-bank");

		// A misconfigured registry resolves no entities: denial names that, not bank policy.
		const missing = new BankPolicyRegistry({ registryRoot: join(workRoot, "does-not-exist") });
		const misconfigured = await missing.decideAutoRetain("agent-bank");
		expect(misconfigured.allowed).toBe(false);
		if (!misconfigured.allowed) {
			expect(misconfigured.reason).toBe("registry-unresolved");
			expect(misconfigured.message).toContain("OMP_ENTITY_REGISTRY");
		}
	});
});

describe("forget — removes a memory", () => {
	it("removes a retained memory by id and reports removal", async () => {
		const store = newStore();
		try {
			const id = store.retain("agent-bank", "temporary scaffold note to be forgotten");
			expect(contentsOf(await store.recall("agent-bank", "scaffold"))).toContain("scaffold");

			expect(store.forget("agent-bank", id)).toBe(true);
			// A second forget of the same id is a no-op.
			expect(store.forget("agent-bank", id)).toBe(false);

			expect(contentsOf(await store.recall("agent-bank", "scaffold"))).not.toContain("temporary scaffold note");
		} finally {
			store.close();
		}
	});
});

describe("MemoryMcpServer — JSON-RPC surface", () => {
	function server(): MemoryMcpServer {
		return new MemoryMcpServer({ noEmbeddings: true, dataDir, registryRoot });
	}

	function rpc(
		srv: MemoryMcpServer,
		method: string,
		params?: Record<string, unknown>,
	): Promise<JsonRpcResponse | null> {
		const request: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method, params };
		return srv.handleJsonRpc(request);
	}

	/** Narrow a JSON-RPC response's `result` to a plain object. */
	function resultObject(res: JsonRpcResponse | null): Record<string, unknown> {
		if (!isRecord(res?.result)) throw new Error("expected an object result");
		return res.result;
	}

	/** Extract a `tools/call` result's text payload + error flag via guards (no casts). */
	function toolPayload(res: JsonRpcResponse | null): { payload: Record<string, unknown>; isError: boolean } {
		const result = resultObject(res);
		const content = result.content;
		if (!Array.isArray(content) || content.length === 0) throw new Error("expected tool content");
		const first: unknown = content[0];
		if (!isRecord(first) || typeof first.text !== "string") throw new Error("expected text content");
		const parsed: unknown = JSON.parse(first.text);
		if (!isRecord(parsed)) throw new Error("expected an object payload");
		return { payload: parsed, isError: result.isError === true };
	}

	it("initialize advertises the server and tools capability", async () => {
		const srv = server();
		try {
			const result = resultObject(await rpc(srv, "initialize"));
			expect(isRecord(result.serverInfo) && result.serverInfo.name).toBe("omp-memory");
			expect(isRecord(result.capabilities) && "tools" in result.capabilities).toBe(true);
		} finally {
			srv.close();
		}
	});

	it("tools/list exposes exactly recall, retain, forget", async () => {
		const srv = server();
		try {
			const result = resultObject(await rpc(srv, "tools/list"));
			const tools = result.tools;
			if (!Array.isArray(tools)) throw new Error("expected tools array");
			const names = tools.map(t => (isRecord(t) && typeof t.name === "string" ? t.name : "")).sort();
			expect(names).toEqual(["forget", "recall", "retain"]);
		} finally {
			srv.close();
		}
	});

	it("tools/call round-trips retain -> recall over JSON-RPC", async () => {
		const srv = server();
		try {
			const retained = toolPayload(
				await rpc(srv, "tools/call", {
					name: "retain",
					arguments: { bank: "agent-bank", memory: "peregrine dive velocity record" },
				}),
			);
			expect(retained.isError).toBe(false);
			expect(retained.payload.id).toBeTruthy();

			const recalled = toolPayload(
				await rpc(srv, "tools/call", {
					name: "recall",
					arguments: { bank: "agent-bank", query: "peregrine" },
				}),
			);
			const results = recalled.payload.results;
			const joined = Array.isArray(results)
				? results.map(r => (isRecord(r) && typeof r.content === "string" ? r.content : "")).join(" ")
				: "";
			expect(joined).toContain("peregrine");
		} finally {
			srv.close();
		}
	});

	it("addresses two banks concurrently through one running server, kept scoped", async () => {
		const srv = server();
		try {
			// Interleaved concurrent retains into distinct banks via one server surface.
			const [a, p] = await Promise.all([
				rpc(srv, "tools/call", {
					name: "retain",
					arguments: { bank: "agent-bank", memory: "tanager plumage field note" },
				}),
				rpc(srv, "tools/call", {
					name: "retain",
					arguments: { bank: "persona-bank", memory: "ganache tempering lesson" },
				}),
			]);
			expect(toolPayload(a).payload.id).toBeTruthy();
			expect(toolPayload(p).payload.id).toBeTruthy();

			// Concurrent recall against each bank returns only that bank's data.
			const [ar, pr] = await Promise.all([
				rpc(srv, "tools/call", { name: "recall", arguments: { bank: "agent-bank", query: "tanager" } }),
				rpc(srv, "tools/call", { name: "recall", arguments: { bank: "persona-bank", query: "ganache" } }),
			]);
			const joined = (res: JsonRpcResponse | null): string => {
				const results = toolPayload(res).payload.results;
				return Array.isArray(results)
					? results.map(r => (isRecord(r) && typeof r.content === "string" ? r.content : "")).join(" ")
					: "";
			};
			expect(joined(ar)).toContain("tanager");
			expect(joined(ar)).not.toContain("ganache");
			expect(joined(pr)).toContain("ganache");
			expect(joined(pr)).not.toContain("tanager");

			// Both banks are live on the one server (no cross-close between calls).
			expect(srv.store.openBanks().sort()).toEqual(["agent-bank", "persona-bank"]);
		} finally {
			srv.close();
		}
	});

	it("tools/call surfaces a policy rejection as an isError result, not a crash", async () => {
		const srv = server();
		try {
			const res = await rpc(srv, "tools/call", {
				name: "retain",
				arguments: { bank: "persona-bank", memory: "auto write", mode: "auto" },
			});
			const result = resultObject(res);
			expect(result.isError).toBe(true);
			const content = result.content;
			const text =
				Array.isArray(content) && isRecord(content[0]) && typeof content[0].text === "string"
					? content[0].text
					: "";
			expect(text).toContain("curated-only");
		} finally {
			srv.close();
		}
	});

	it("defaults bank to the server's configured bank when a call omits it (per-entity binding)", async () => {
		const srv = new MemoryMcpServer({ noEmbeddings: true, dataDir, registryRoot, defaultBank: "agent-bank" });
		try {
			// retain with no bank -> lands in the configured default bank.
			const retained = toolPayload(
				await rpc(srv, "tools/call", { name: "retain", arguments: { memory: "godwit tideline sighting" } }),
			);
			expect(retained.isError).toBe(false);
			expect(retained.payload.bank).toBe("agent-bank");
			// recall with no bank -> reads the same default bank.
			const recalled = toolPayload(await rpc(srv, "tools/call", { name: "recall", arguments: { query: "godwit" } }));
			expect(recalled.payload.bank).toBe("agent-bank");
			const results = recalled.payload.results;
			const joined = Array.isArray(results)
				? results.map(r => (isRecord(r) && typeof r.content === "string" ? r.content : "")).join(" ")
				: "";
			expect(joined).toContain("godwit");
			// An explicit bank still overrides the default.
			const overridden = toolPayload(
				await rpc(srv, "tools/call", {
					name: "retain",
					arguments: { bank: "persona-bank", memory: "brioche proofing lesson" },
				}),
			);
			expect(overridden.payload.bank).toBe("persona-bank");
		} finally {
			srv.close();
		}
	});

	it("errors when a call omits bank and no default is configured", async () => {
		const srv = server();
		try {
			const res = await rpc(srv, "tools/call", { name: "recall", arguments: { query: "anything" } });
			const result = resultObject(res);
			expect(result.isError).toBe(true);
			const content = result.content;
			const text =
				Array.isArray(content) && isRecord(content[0]) && typeof content[0].text === "string"
					? content[0].text
					: "";
			expect(text).toContain("bank");
		} finally {
			srv.close();
		}
	});
});
