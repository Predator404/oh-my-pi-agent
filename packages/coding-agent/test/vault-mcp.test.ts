import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	cosineSimilarity,
	type Embedder,
	getToolDefinitions,
	handleJsonRpc,
	handleToolCall,
	loadSmartConnectionsStore,
	resolveVaultRoot,
	VaultBridge,
	VaultGraph,
	vaultMcpServerConfig,
} from "@oh-my-pi/pi-coding-agent/vault-mcp";

const MODEL_KEY = "TaylorAI/bge-micro-v2";

// --- Deterministic 4-dim embedder (no model load, no network) --------------
// Maps query keywords to the same axis the fixture blocks were embedded on.
const QUERY_VECS: Record<string, number[]> = {
	daemon: [1, 0, 0, 0],
	memory: [0, 1, 0, 0],
	search: [0, 0, 1, 0],
	color: [0, 0, 0, 1],
};

class FakeEmbedder implements Embedder {
	readonly modelKey = MODEL_KEY;
	readonly dimensions = 4;
	calls = 0;
	async embed(text: string): Promise<number[]> {
		this.calls++;
		const lower = text.toLowerCase();
		for (const [kw, vec] of Object.entries(QUERY_VECS)) {
			if (lower.includes(kw)) return vec;
		}
		return [0.5, 0.5, 0.5, 0.5];
	}
}

// --- Fixture vault ----------------------------------------------------------
const ARCHITECTURE = `## Daemon
The daemon supervisor routes messages.
It survives detach.

## Memory
Banks are scoped per entity.
Recall on session start.

Related: [[tools]] and [[design]].
`;

const TOOLS = `## Search
Semantic search returns block-level hits.
Uses local embeddings only.

Back to [[architecture]].
`;

const DESIGN = `## Colors
Use a calm palette.
Accent sparingly.
`;

/** Build the .smart-env store: source + block entries with matching line ranges. */
function ajsonBody(): string {
	const vec = (v: number[]) => ({ embeddings: { [MODEL_KEY]: { vec: v } } });
	const entries: Record<string, unknown> = {
		"smart_sources:agents/phi/architecture.md": {
			...vec([0.7, 0.7, 0, 0]),
			blocks: { "#Daemon": { lines: [1, 3] }, "#Memory": { lines: [5, 7] } },
		},
		"smart_blocks:agents/phi/architecture.md#Daemon": vec([1, 0, 0, 0]),
		"smart_blocks:agents/phi/architecture.md#Memory": vec([0, 1, 0, 0]),
		"smart_sources:agents/phi/tools.md": {
			...vec([0, 0, 1, 0]),
			blocks: { "#Search": { lines: [1, 3] } },
		},
		"smart_blocks:agents/phi/tools.md#Search": vec([0, 0, 1, 0]),
		"smart_sources:personas/mel/design.md": {
			...vec([0, 0, 0, 1]),
			blocks: { "#Colors": { lines: [1, 3] } },
		},
		"smart_blocks:personas/mel/design.md#Colors": vec([0, 0, 0, 1]),
	};
	// Append-JSON: "key": value, one per line (no wrapping braces).
	return Object.entries(entries)
		.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
		.join(",\n");
}

let vaultRoot: string;

beforeAll(() => {
	vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vault-"));
	fs.mkdirSync(path.join(vaultRoot, "agents/phi"), { recursive: true });
	fs.mkdirSync(path.join(vaultRoot, "personas/mel"), { recursive: true });
	fs.writeFileSync(path.join(vaultRoot, "agents/phi/architecture.md"), ARCHITECTURE);
	fs.writeFileSync(path.join(vaultRoot, "agents/phi/tools.md"), TOOLS);
	fs.writeFileSync(path.join(vaultRoot, "personas/mel/design.md"), DESIGN);
	const envDir = path.join(vaultRoot, ".smart-env");
	fs.mkdirSync(path.join(envDir, "multi"), { recursive: true });
	fs.writeFileSync(
		path.join(envDir, "smart_env.json"),
		JSON.stringify({ smart_sources: { embed_model: { transformers: { model_key: MODEL_KEY } } } }),
	);
	fs.writeFileSync(path.join(envDir, "multi", "all.ajson"), ajsonBody());
});

afterAll(() => {
	fs.rmSync(vaultRoot, { recursive: true, force: true });
});

function bridge(section?: string): VaultBridge {
	return new VaultBridge({ vaultRoot, section, embedder: new FakeEmbedder() });
}

// --- Store reader -----------------------------------------------------------
describe("smart connections store", () => {
	it("parses source + block entries and merges line ranges", () => {
		const store = loadSmartConnectionsStore(vaultRoot);
		expect(store.model.modelKey).toBe(MODEL_KEY);
		expect(store.model.dimensions).toBe(384);
		const daemon = store.entries.get("agents/phi/architecture.md#Daemon");
		expect(daemon?.kind).toBe("block");
		expect(daemon?.filePath).toBe("agents/phi/architecture.md");
		expect(daemon?.lines).toEqual([1, 3]);
		expect(store.entries.get("agents/phi/architecture.md")?.kind).toBe("source");
	});

	it("returns an empty store for an unindexed vault (no throw)", () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vault-empty-"));
		try {
			expect(loadSmartConnectionsStore(empty).entries.size).toBe(0);
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
	});
});

// --- Semantic search --------------------------------------------------------
describe("search_notes (semantic, block-level, scoped)", () => {
	it("returns block-level hits ranked by cosine similarity", async () => {
		const hits = await bridge("agents/phi").searchNotes("tell me about the daemon");
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].granularity).toBe("block");
		expect(hits[0].file).toBe("agents/phi/architecture.md");
		expect(hits[0].heading).toBe("Daemon");
		expect(hits[0].lines).toEqual([1, 3]);
		expect(hits[0].text).toContain("daemon supervisor");
		expect(hits[0].score).toBeGreaterThan(0.99);
	});

	it("scopes results to the requested section", async () => {
		const hits = await bridge().searchNotes("color palette", { section: "personas/mel" });
		expect(hits.length).toBeGreaterThan(0);
		for (const h of hits) expect(h.file.startsWith("personas/mel/")).toBe(true);
	});

	it("never leaks hits outside the bridge's owning section", async () => {
		const hits = await bridge("agents/phi").searchNotes("color");
		for (const h of hits) expect(h.file.startsWith("agents/phi/")).toBe(true);
	});

	it("honors k", async () => {
		const hits = await bridge("agents/phi").searchNotes("memory banks", { k: 1 });
		expect(hits.length).toBe(1);
		expect(hits[0].heading).toBe("Memory");
	});

	it("rejects an empty query", async () => {
		await expect(bridge("agents/phi").searchNotes("  ")).rejects.toThrow(/non-empty/);
	});
});

// --- get_note + confinement -------------------------------------------------
describe("get_note", () => {
	it("reads a note's markdown", () => {
		const note = bridge().getNote("agents/phi/tools.md");
		expect(note.path).toBe("agents/phi/tools.md");
		expect(note.content).toContain("Semantic search");
	});

	it("blocks path traversal out of the vault", () => {
		expect(() => bridge().getNote("../../../etc/passwd")).toThrow(/escapes vault root/);
	});
});

// --- write_note -------------------------------------------------------------
describe("write_note (plain-file, section-scoped)", () => {
	afterEach(() => {
		fs.rmSync(path.join(vaultRoot, "agents/phi/notes"), { recursive: true, force: true });
		fs.rmSync(path.join(vaultRoot, "personas/mel/extra.md"), { force: true });
	});

	it("roots a bare relative path under the owning section", () => {
		const res = bridge("agents/phi").writeNote("notes/today.md", "# Today\nhello");
		expect(res.path).toBe("agents/phi/notes/today.md");
		expect(res.created).toBe(true);
		expect(fs.readFileSync(path.join(vaultRoot, "agents/phi/notes/today.md"), "utf8")).toContain("Today");
	});

	it("honors an explicit section prefix targeting another subtree", () => {
		const res = bridge("agents/phi").writeNote("personas/mel/extra.md", "# Extra");
		expect(res.path).toBe("personas/mel/extra.md");
		expect(fs.existsSync(path.join(vaultRoot, "personas/mel/extra.md"))).toBe(true);
	});

	it("rejects a non-markdown path", () => {
		expect(() => bridge("agents/phi").writeNote("notes/data.json", "{}")).toThrow(/markdown/);
	});
});

// --- Graph / connections ----------------------------------------------------
describe("get_connections (wikilink/backlink traversal)", () => {
	it("resolves forward wikilinks and backlinks", () => {
		const conn = bridge().getConnections("agents/phi/architecture.md");
		expect(conn.file).toBe("agents/phi/architecture.md");
		const out = conn.linksOut.map(l => l.resolved).sort();
		expect(out).toEqual(["agents/phi/tools.md", "personas/mel/design.md"]);
		expect(conn.linksIn.map(l => l.source)).toEqual(["agents/phi/tools.md"]);
	});

	it("surfaces vector neighbors of the entry note", () => {
		const conn = bridge().getConnections("agents/phi/architecture.md");
		expect(conn.relatedByVector.length).toBeGreaterThan(0);
		expect(conn.relatedByVector.every(r => r.file !== "agents/phi/architecture.md")).toBe(true);
	});

	it("throws for a missing note", () => {
		expect(() => bridge().getConnections("agents/phi/missing.md")).toThrow(/not found/);
	});
});

describe("VaultGraph direct", () => {
	it("builds a reverse index", () => {
		const graph = new VaultGraph(vaultRoot).build();
		expect(graph.linksIn("agents/phi/architecture.md").map(b => b.source)).toEqual(["agents/phi/tools.md"]);
	});
});

// --- No cloud calls ---------------------------------------------------------
describe("no cloud calls", () => {
	it("performs the full read/write/graph/search path without touching the network", async () => {
		const original = globalThis.fetch;
		let fetchCalls = 0;
		// Stub with a reason: `fetch`'s full type includes `preconnect`; the test only
		// needs the call signature to prove the core path issues no network request.
		const throwingFetch = (async () => {
			fetchCalls++;
			throw new Error("network access is forbidden in the vault MCP core path");
		}) as unknown as typeof fetch;
		globalThis.fetch = throwingFetch;
		try {
			const b = bridge("agents/phi");
			await b.searchNotes("daemon");
			b.getNote("agents/phi/tools.md");
			b.getConnections("agents/phi/architecture.md");
			b.writeNote("notes/scratch.md", "# scratch");
			expect(fetchCalls).toBe(0);
		} finally {
			globalThis.fetch = original;
			fs.rmSync(path.join(vaultRoot, "agents/phi/notes"), { recursive: true, force: true });
		}
	});
});

// --- Tool surface + JSON-RPC ------------------------------------------------
describe("C3 tool surface", () => {
	it("exposes exactly the four C3 tools", () => {
		const names = getToolDefinitions()
			.map(t => t.name)
			.sort();
		expect(names).toEqual(["get_connections", "get_note", "search_notes", "write_note"]);
	});

	it("dispatches search_notes via handleToolCall", async () => {
		const result = await handleToolCall(bridge("agents/phi"), "search_notes", { query: "daemon" });
		expect(result.count).toBeGreaterThan(0);
		expect(Array.isArray(result.hits)).toBe(true);
	});

	it("rejects an unknown tool", async () => {
		await expect(handleToolCall(bridge(), "nope", {})).rejects.toThrow(/Unknown tool/);
	});

	it("answers initialize and tools/list over JSON-RPC", async () => {
		const init = await handleJsonRpc(bridge(), { jsonrpc: "2.0", id: 1, method: "initialize" });
		expect(init?.result).toMatchObject({ protocolVersion: "2024-11-05", serverInfo: { name: "omp-vault" } });
		const list = await handleJsonRpc(bridge(), { jsonrpc: "2.0", id: 2, method: "tools/list" });
		const listResult = list?.result;
		const tools =
			listResult && typeof listResult === "object" && "tools" in listResult ? listResult.tools : undefined;
		expect(Array.isArray(tools) && tools.length).toBe(4);
	});

	it("ignores notifications (no reply)", async () => {
		expect(await handleJsonRpc(bridge(), { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
	});

	it("wraps tool errors as MCP isError content", async () => {
		const res = await handleJsonRpc(bridge(), {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "get_note", arguments: { path: "../escape.md" } },
		});
		const result = res?.result;
		const record = result && typeof result === "object" ? result : {};
		expect("isError" in record && record.isError === true).toBe(true);
		const items = "content" in record && Array.isArray(record.content) ? record.content : [];
		const first = items[0];
		const text = first && typeof first === "object" && "text" in first ? first.text : undefined;
		expect(typeof text === "string" && text.includes("escapes vault root")).toBe(true);
	});
});

// --- Acceptance §12.4 hardening (WS4Tester) --------------------------------
describe("acceptance §12.4 hardening", () => {
	it("section scope is path-segment aware (no sibling-prefix leak)", async () => {
		// A scope of "agents/ph" must NOT capture "agents/phi/..." blocks.
		const hits = await bridge().searchNotes("daemon", { section: "agents/ph" });
		expect(hits).toEqual([]);
	});

	it("handleToolCall search_notes scopes to an explicit section and reports it", async () => {
		// "color" ranks design.md (personas/mel) #1; an agents/phi bridge would drop it,
		// but an explicit section arg re-scopes and the dispatch reports the effective scope.
		const res = await handleToolCall(bridge("agents/phi"), "search_notes", {
			query: "color",
			section: "personas/mel",
		});
		expect(res.section).toBe("personas/mel");
		const hits = res.hits as Array<{ file: string; granularity: string }>;
		expect(res.count).toBe(hits.length);
		expect(hits.length).toBeGreaterThan(0);
		for (const h of hits) expect(h.file.startsWith("personas/mel/")).toBe(true);
	});

	it("handleToolCall write_note lands a bare path in the owning section", async () => {
		try {
			const res = (await handleToolCall(bridge("agents/phi"), "write_note", {
				path: "notes/dispatch.md",
				content: "# via dispatch",
			})) as { path: string; created: boolean };
			expect(res.path).toBe("agents/phi/notes/dispatch.md");
			expect(res.created).toBe(true);
			expect(fs.readFileSync(path.join(vaultRoot, "agents/phi/notes/dispatch.md"), "utf8")).toContain(
				"via dispatch",
			);
		} finally {
			fs.rmSync(path.join(vaultRoot, "agents/phi/notes"), { recursive: true, force: true });
		}
	});

	it("get_connections dispatch confines the entry path to the vault", async () => {
		await expect(handleToolCall(bridge(), "get_connections", { path: "../../etc/hosts" })).rejects.toThrow(
			/escapes vault root/,
		);
	});
});

// --- Helpers ----------------------------------------------------------------
describe("helpers", () => {
	it("resolveVaultRoot honors explicit > env > ~/vault", () => {
		expect(resolveVaultRoot("/tmp/x")).toBe(path.resolve("/tmp/x"));
	});

	it("cosineSimilarity of orthogonal vectors is 0, identical is 1", () => {
		expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
		expect(cosineSimilarity([1, 1], [1, 1])).toBeCloseTo(1, 6);
	});

	it("vaultMcpServerConfig builds the omp-vault-mcp entry", () => {
		const cfg = vaultMcpServerConfig({ vaultRoot: "/v", section: "agents/phi" });
		expect(cfg.command).toBe("omp-vault-mcp");
		expect(cfg.args).toEqual(["--vault", "/v", "--section", "agents/phi"]);
		const dev = vaultMcpServerConfig({ vaultRoot: "/v", serverModule: "/s/server.ts" });
		expect(dev.command).toBe("bun");
		expect(dev.args).toEqual(["run", "/s/server.ts", "--vault", "/v"]);
	});
});

// --- Review follow-ups (P2 model match, P3a symmetry, P3b resolution) -------
describe("query embedder must match the stored model (P2)", () => {
	it("throws a clear error when the injected embedder model differs from the store", async () => {
		const mismatched: Embedder = { modelKey: "other/model", dimensions: 4, embed: async () => [1, 0, 0, 0] };
		const b = new VaultBridge({ vaultRoot, section: "agents/phi", embedder: mismatched });
		await expect(b.searchNotes("daemon")).rejects.toThrow(/does not match the vault's stored embedding model/);
	});
});

describe("write/read round-trip is symmetric (P3a)", () => {
	it("get_note resolves a bare path the same way write_note rooted it", () => {
		const b = bridge("agents/phi");
		try {
			const written = b.writeNote("roundtrip.md", "# Roundtrip\nbody");
			expect(written.path).toBe("agents/phi/roundtrip.md");
			expect(b.getNote("roundtrip.md").content).toContain("Roundtrip");
		} finally {
			fs.rmSync(path.join(vaultRoot, "agents/phi/roundtrip.md"), { force: true });
		}
	});
});

describe("link resolution prefers exact/same-folder, unresolved on ambiguity (P3b)", () => {
	let gvault: string;
	beforeAll(() => {
		gvault = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vault-graph-"));
		fs.mkdirSync(path.join(gvault, "a"), { recursive: true });
		fs.mkdirSync(path.join(gvault, "b"), { recursive: true });
		fs.writeFileSync(path.join(gvault, "a/note.md"), "Link to [[dup]].\n");
		fs.writeFileSync(path.join(gvault, "a/dup.md"), "A dup.\n");
		fs.writeFileSync(path.join(gvault, "b/dup.md"), "B dup.\n");
		fs.writeFileSync(path.join(gvault, "outside.md"), "Link to [[dup]].\n");
	});
	afterAll(() => fs.rmSync(gvault, { recursive: true, force: true }));

	it("resolves a same-folder link to the sibling note", () => {
		const graph = new VaultGraph(gvault).build();
		expect(graph.linksOut("a/note.md")[0].resolved).toBe("a/dup.md");
	});

	it("leaves a genuinely ambiguous basename unresolved", () => {
		const graph = new VaultGraph(gvault).build();
		expect(graph.linksOut("outside.md")[0].resolved).toBeUndefined();
	});
});

// --- Multi-registry access set (ADR 0004 directional reads) -----------------
describe("multi-registry access set (ADR 0004 directional reads)", () => {
	let otherRoot: string;
	const GUIDE = `## Guide\nSemantic search across the reference.\nLocal only.\n`;

	function otherAjson(): string {
		const vec = (v: number[]) => ({ embeddings: { [MODEL_KEY]: { vec: v } } });
		const entries: Record<string, unknown> = {
			"smart_sources:reference/guide.md": { ...vec([0, 0, 1, 0]), blocks: { "#Guide": { lines: [1, 3] } } },
			"smart_blocks:reference/guide.md#Guide": vec([0, 0, 1, 0]),
		};
		return Object.entries(entries)
			.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
			.join(",\n");
	}

	beforeAll(() => {
		otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vault-other-"));
		fs.mkdirSync(path.join(otherRoot, "reference"), { recursive: true });
		fs.writeFileSync(path.join(otherRoot, "reference/guide.md"), GUIDE);
		const envDir = path.join(otherRoot, ".smart-env");
		fs.mkdirSync(path.join(envDir, "multi"), { recursive: true });
		fs.writeFileSync(
			path.join(envDir, "smart_env.json"),
			JSON.stringify({ smart_sources: { embed_model: { transformers: { model_key: MODEL_KEY } } } }),
		);
		fs.writeFileSync(path.join(envDir, "multi", "all.ajson"), otherAjson());
	});

	afterAll(() => fs.rmSync(otherRoot, { recursive: true, force: true }));

	// Home = "phi" (agents/phi), granted read-only registry "capitec" = otherRoot.
	function accessBridge(): VaultBridge {
		return new VaultBridge({
			vaultRoot,
			section: "agents/phi",
			embedder: new FakeEmbedder(),
			homeId: "phi",
			readable: [{ id: "capitec", root: otherRoot }],
		});
	}

	it("enumerates the visible registry ids, home first", () => {
		expect(accessBridge().registryIds()).toEqual(["phi", "capitec"]);
	});

	it("(a) reads a granted registry and returns hits from that root", async () => {
		const hits = await accessBridge().searchNotes("semantic search", { registry: "capitec" });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].file).toBe("reference/guide.md");
		expect(hits[0].text).toContain("Semantic search");
	});

	it("(a) get_note reads a note from the granted registry root", () => {
		const note = accessBridge().getNote("reference/guide.md", "capitec");
		expect(note.path).toBe("reference/guide.md");
		expect(note.content).toContain("Local only");
	});

	it("(b) rejects a read against an ungranted/unknown registry id", async () => {
		const b = accessBridge();
		await expect(b.searchNotes("search", { registry: "unknown" })).rejects.toThrow(/not accessible/);
		expect(() => b.getNote("reference/guide.md", "unknown")).toThrow(/not accessible/);
		expect(() => b.getConnections("reference/guide.md", "unknown")).toThrow(/not accessible/);
	});

	it("(c) write_note lands in home even when a registry arg is supplied", async () => {
		const b = accessBridge();
		try {
			// write_note carries no registry param; a stray dispatch arg is ignored.
			const res = (await handleToolCall(b, "write_note", {
				path: "notes/pin.md",
				content: "# pin",
				registry: "capitec",
			})) as { path: string };
			expect(res.path).toBe("agents/phi/notes/pin.md");
			expect(fs.existsSync(path.join(vaultRoot, "agents/phi/notes/pin.md"))).toBe(true);
			// The read-only registry root is never written to.
			expect(fs.existsSync(path.join(otherRoot, "agents/phi/notes/pin.md"))).toBe(false);
			expect(fs.existsSync(path.join(otherRoot, "notes/pin.md"))).toBe(false);
		} finally {
			fs.rmSync(path.join(vaultRoot, "agents/phi/notes"), { recursive: true, force: true });
		}
	});

	it("(d) default search_notes stays home-only (no union across roots)", async () => {
		const hits = await accessBridge().searchNotes("semantic search");
		expect(hits.length).toBeGreaterThan(0);
		for (const h of hits) expect(h.file.startsWith("reference/")).toBe(false);
	});

	it("(e) the path-jail rejects `..`/outside-root paths on the granted root too", () => {
		const b = accessBridge();
		expect(() => b.getNote("../../../etc/passwd", "capitec")).toThrow(/escapes vault root/);
		expect(() => b.getConnections("../outside.md", "capitec")).toThrow(/escapes vault root/);
	});
});
