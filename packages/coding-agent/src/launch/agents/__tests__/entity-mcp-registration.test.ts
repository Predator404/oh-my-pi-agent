/**
 * Unit — entity worker MCP tool registration (regression for the provided-manager gap).
 *
 * `createAgentSession` only auto-registers MCP tools when it OWNS the manager
 * (`enableMCP && !options.mcpManager` in sdk.ts). An entity worker builds its
 * own manager (`buildEntityMcpManager`) and passes it in, hitting the
 * subagent-inheritance path — which assumes a parent already registered the
 * tools. With no parent, the entity's memory + vault tools connected but never
 * surfaced. `registerEntityMcpTools` closes that gap; these tests pin its
 * observable contract with lightweight doubles (no real session/provider).
 */
import { describe, expect, mock, test } from "bun:test";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { registerEntityMcpTools } from "../agent-worker-main";

/** Minimal tool-list fixtures; the helper only ever passes the list through. */
const TOOLS: CustomTool[] = [];
const CHANGED: CustomTool[] = [];

describe("registerEntityMcpTools", () => {
	test("registers the manager's current tools onto the session once", async () => {
		const refreshMCPTools = mock(async (_tools: CustomTool[]) => {});
		const getTools = mock((): CustomTool[] => TOOLS);
		const setOnToolsChanged = mock((_h: (tools: CustomTool[]) => void | Promise<void>) => {});

		await registerEntityMcpTools({ refreshMCPTools }, { getTools, setOnToolsChanged });

		expect(getTools).toHaveBeenCalledTimes(1);
		expect(refreshMCPTools).toHaveBeenCalledTimes(1);
		// The exact array the manager reported is what gets registered.
		expect(refreshMCPTools.mock.calls[0]![0]).toBe(TOOLS);
	});

	test("keeps tools live: a tools/list_changed notification re-registers", async () => {
		const refreshMCPTools = mock(async (_tools: CustomTool[]) => {});
		let handler: ((tools: CustomTool[]) => void | Promise<void>) | undefined;
		const setOnToolsChanged = mock((h: (tools: CustomTool[]) => void | Promise<void>) => {
			handler = h;
		});

		await registerEntityMcpTools({ refreshMCPTools }, { getTools: () => TOOLS, setOnToolsChanged });

		expect(setOnToolsChanged).toHaveBeenCalledTimes(1);
		expect(handler).toBeDefined();

		await handler!(CHANGED);
		expect(refreshMCPTools).toHaveBeenCalledTimes(2);
		expect(refreshMCPTools.mock.calls[1]![0]).toBe(CHANGED);
	});

	test("a failing refresh inside the change handler is swallowed, never thrown", async () => {
		let handler: ((tools: CustomTool[]) => void | Promise<void>) | undefined;
		const refreshMCPTools = mock(async (tools: CustomTool[]) => {
			// Fail only on the change-driven refresh, not the initial one.
			if (tools === CHANGED) throw new Error("boom");
		});
		const setOnToolsChanged = mock((h: (tools: CustomTool[]) => void | Promise<void>) => {
			handler = h;
		});

		await registerEntityMcpTools({ refreshMCPTools }, { getTools: () => TOOLS, setOnToolsChanged });

		// The handler is fire-and-forget (returns void); invoking it must not throw
		// even though the underlying refresh rejects.
		expect(() => handler!(CHANGED)).not.toThrow();
		// Give the swallowed rejection a microtask to settle.
		await Promise.resolve();
		expect(refreshMCPTools).toHaveBeenCalledTimes(2);
	});
});
