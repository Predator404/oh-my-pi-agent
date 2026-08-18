import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandJournal } from "../command-journal";
import type { AgentControlResult } from "../control-protocol";

const OK: AgentControlResult = {
	type: "goal_set",
	ok: true,
	goal: { active: true, status: "active", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 },
};

describe("command journal", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "omp-journal-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("admits a fresh command once, replays the recorded result after completion", () => {
		const journal = new CommandJournal();
		expect(journal.begin("client", "cmd-1")).toEqual({ status: "fresh" });
		journal.complete("client", "cmd-1", OK);
		expect(journal.begin("client", "cmd-1")).toEqual({ status: "replay", result: OK });
	});

	test("reports an in-flight (never-completed) command as uncertain, does not re-admit", () => {
		const journal = new CommandJournal();
		expect(journal.begin("client", "cmd-2").status).toBe("fresh");
		// No complete() — a crash mid-dispatch. A duplicate must be uncertain.
		expect(journal.begin("client", "cmd-2")).toEqual({ status: "uncertain" });
	});

	test("abort clears a pending entry so a corrected retry is fresh", () => {
		const journal = new CommandJournal();
		journal.begin("client", "cmd-3");
		journal.abort("client", "cmd-3");
		expect(journal.begin("client", "cmd-3")).toEqual({ status: "fresh" });
	});

	test("keys are scoped per client", () => {
		const journal = new CommandJournal();
		journal.begin("A", "cmd");
		journal.complete("A", "cmd", OK);
		expect(journal.begin("B", "cmd")).toEqual({ status: "fresh" });
	});

	test("persists across a reload: completed replays, in-flight is uncertain", () => {
		const path = join(dir, "journal.jsonl");
		const first = new CommandJournal(path);
		first.begin("c", "done");
		first.complete("c", "done", OK);
		first.begin("c", "pending"); // began, never completed

		const reloaded = new CommandJournal(path);
		expect(reloaded.begin("c", "done")).toEqual({ status: "replay", result: OK });
		expect(reloaded.begin("c", "pending")).toEqual({ status: "uncertain" });
	});
});
