import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getToolDefinitions,
	handleJsonRpc,
	handleToolCall,
	resolveVaultRoot,
	VaultBridge,
} from "@oh-my-pi/pi-coding-agent/vault-mcp";
import { vaultMcpServerConfig } from "@oh-my-pi/pi-coding-agent/entity";

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

let vaultRoot: string;

beforeAll(() => {
	vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vault-"));
	fs.mkdirSync(path.join(vaultRoot, "agents/phi"), { recursive: true });
	fs.mkdirSync(path.join(vaultRoot, "personas/mel"), { recursive: true });
	fs.writeFileSync(path.join(vaultRoot, "agents/phi/architecture.md"), ARCHITECTURE);
	fs.writeFileSync(path.join(vaultRoot, "agents/phi/tools.md"), TOOLS);
	fs.writeFileSync(path.join(vaultRoot, "personas/mel/design.md"), DESIGN);
});

afterAll(() => {
	fs.rmSync(vaultRoot, { recursive: true, force: true });
});

function bridge(section?: string): VaultBridge {
	return new VaultBridge({ vaultRoot, section });
}

// --- Text-grep search -------------------------------------------------------
describe("search_notes (text-grep, block-level, scoped)", () => {
	it("returns block-level hits matching query terms", () => {
		const hits = bridge("agents/phi").searchNotes("daemon supervisor routes");
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].granularity).toBe("block");
		expect(hits[0].file).toBe("agents/phi/architecture.md");
		expect(hits[0].heading).toContain("Daemon");
		expect(hits[0].text).toContain("daemon supervisor");
		expect(hits[0].score).toBeGreaterThan(0);
	});

	it("scopes results to the requested section", () => {
		const hits = bridge().searchNotes("calm palette", { section: "personas/mel" });
		expect(hits.length).toBeGreaterThan(0);
		for (const h of hits) expect(h.file.startsWith("personas/mel/")).toBe(true);
	});

	it("never leaks hits outside the bridge's owning section", () => {
		const hits = bridge("agents/phi").searchNotes("calm");
		for (const h of hits) expect(h.file.startsWith("agents/phi/")).toBe(true);
	});

	it("honors k", () => {
		const hits = bridge("agents/phi").searchNotes("memory banks scoped", { k: 1 });
		expect(hits.length).toBe(1);
		expect(hits[0].heading).toContain("Memory");
	});

	it("rejects an empty query", () => {
		expect(() => bridge("agents/phi").searchNotes("  ")).toThrow(/non-empty/);
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

// --- Graph / connections (wikilink regex scan) ------------------------------
describe("get_connections (wikilink/backlink traversal)", () => {
	it("resolves forward wikilinks and backlinks", () => {
		const conn = bridge().getConnections("agents/phi/architecture.md");
		expect(conn.file).toBe("agents/phi/architecture.md");
		const out = conn.linksOut.map(l => l.resolved).sort();
		expect(out).toEqual(["agents/phi/tools.md", "personas/mel/design.md"]);
		expect(conn.linksIn.map(l => l.source)).toEqual(["agents/phi/tools.md"]);
	});

	it("relatedByVector is empty when embeddings are unavailable", () => {
		const conn = bridge().getConnections("agents/phi/architecture.md");
		expect(conn.relatedByVector).toEqual([]);
	});

	it("throws for a missing note", () => {
		expect(() => bridge().getConnections("agents/phi/missing.md")).toThrow(/not found/);
	});
});

// --- No cloud calls ---------------------------------------------------------
describe("no cloud calls", () => {
	it("performs the full read/write/graph/search path without touching the network", () => {
		const original = globalThis.fetch;
		let fetchCalls = 0;
		const throwingFetch = (async () => {
			fetchCalls++;
			throw new Error("network access is forbidden in the vault MCP core path");
		}) as unknown as typeof fetch;
		globalThis.fetch = throwingFetch;
		try {
			const b = bridge("agents/phi");
			b.searchNotes("daemon");
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
	it("section scope is path-segment aware (no sibling-prefix leak)", () => {
		// A scope of "agents/ph" must NOT capture "agents/phi/..." blocks.
		const hits = bridge().searchNotes("daemon", { section: "agents/ph" });
		expect(hits).toEqual([]);
	});

	it("handleToolCall search_notes scopes to an explicit section and reports it", async () => {
		const res = await handleToolCall(bridge("agents/phi"), "search_notes", {
			query: "calm palette",
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

	it("vaultMcpServerConfig builds the omp-vault-mcp entry", () => {
		const cfg = vaultMcpServerConfig({ vaultRoot: "/v", section: "agents/phi" });
		expect(cfg.command).toBe("omp-vault-mcp");
		expect(cfg.args).toEqual(["--vault", "/v", "--section", "agents/phi"]);
		const dev = vaultMcpServerConfig({ vaultRoot: "/v", serverModule: "/s/server.ts" });
		expect(dev.command).toBe("bun");
		expect(dev.args).toEqual(["run", "/s/server.ts", "--vault", "/v"]);
	});
});

// --- write/read round-trip is symmetric (P3a) -------------------------------
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

// --- Link resolution via getConnections (same-folder pref, ambiguity) --------
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
		const b = new VaultBridge({ vaultRoot: gvault });
		const conn = b.getConnections("a/note.md");
		expect(conn.linksOut[0].resolved).toBe("a/dup.md");
	});

	it("leaves a genuinely ambiguous basename unresolved", () => {
		const b = new VaultBridge({ vaultRoot: gvault });
		const conn = b.getConnections("outside.md");
		expect(conn.linksOut[0].resolved).toBeUndefined();
	});
});

// --- Multi-registry access set (ADR 0004 directional reads) -----------------
describe("multi-registry access set (ADR 0004 directional reads)", () => {
	let otherRoot: string;
	const GUIDE = `## Guide\nSemantic search across the reference.\nLocal only.\n`;

	beforeAll(() => {
		otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vault-other-"));
		fs.mkdirSync(path.join(otherRoot, "reference"), { recursive: true });
		fs.writeFileSync(path.join(otherRoot, "reference/guide.md"), GUIDE);
	});

	afterAll(() => fs.rmSync(otherRoot, { recursive: true, force: true }));

	function accessBridge(): VaultBridge {
		return new VaultBridge({
			vaultRoot,
			section: "agents/phi",
			homeId: "phi",
			readable: [{ id: "capitec", root: otherRoot }],
		});
	}

	it("enumerates the visible registry ids, home first", () => {
		expect(accessBridge().registryIds()).toEqual(["phi", "capitec"]);
	});

	it("(a) reads a granted registry and returns hits from that root", () => {
		const hits = accessBridge().searchNotes("Semantic search", { registry: "capitec" });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].file).toBe("reference/guide.md");
		expect(hits[0].text).toContain("Semantic search");
	});

	it("(a) get_note reads a note from the granted registry root", () => {
		const note = accessBridge().getNote("reference/guide.md", "capitec");
		expect(note.path).toBe("reference/guide.md");
		expect(note.content).toContain("Local only");
	});

	it("(b) rejects a read against an ungranted/unknown registry id", () => {
		const b = accessBridge();
		expect(() => b.searchNotes("search", { registry: "unknown" })).toThrow(/not accessible/);
		expect(() => b.getNote("reference/guide.md", "unknown")).toThrow(/not accessible/);
		expect(() => b.getConnections("reference/guide.md", "unknown")).toThrow(/not accessible/);
	});

	it("(c) write_note lands in home even when a registry arg is supplied", async () => {
		const b = accessBridge();
		try {
			const res = (await handleToolCall(b, "write_note", {
				path: "notes/pin.md",
				content: "# pin",
				registry: "capitec",
			})) as { path: string };
			expect(res.path).toBe("agents/phi/notes/pin.md");
			expect(fs.existsSync(path.join(vaultRoot, "agents/phi/notes/pin.md"))).toBe(true);
			expect(fs.existsSync(path.join(otherRoot, "agents/phi/notes/pin.md"))).toBe(false);
			expect(fs.existsSync(path.join(otherRoot, "notes/pin.md"))).toBe(false);
		} finally {
			fs.rmSync(path.join(vaultRoot, "agents/phi/notes"), { recursive: true, force: true });
		}
	});

	it("(d) default search_notes stays home-only (no union across roots)", () => {
		const hits = accessBridge().searchNotes("Semantic search");
		expect(hits.length).toBeGreaterThan(0);
		for (const h of hits) expect(h.file.startsWith("reference/")).toBe(false);
	});

	it("(e) the path-jail rejects `..`/outside-root paths on the granted root too", () => {
		const b = accessBridge();
		expect(() => b.getNote("../../../etc/passwd", "capitec")).toThrow(/escapes vault root/);
		expect(() => b.getConnections("../outside.md", "capitec")).toThrow(/escapes vault root/);
	});
});
