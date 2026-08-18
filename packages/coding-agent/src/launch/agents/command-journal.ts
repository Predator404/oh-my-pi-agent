/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * Command idempotency journal (SPEC §8.3, CONTRACTS.md C4).
 *
 * Every mutating C4 command is keyed by `{clientId + commandId}` and journaled
 * BEFORE it is dispatched to a worker. The invariant the journal enforces:
 *
 *  - A never-seen command runs once (`fresh`) and its result is recorded.
 *  - A replay of a *completed* command returns the recorded result — the
 *    mutation never runs twice.
 *  - A replay of a command that began but never certainly completed (supervisor
 *    crashed mid-dispatch, or a duplicate arrived while the first is in flight)
 *    is reported as `command_result_uncertain` and is NEVER re-dispatched. The
 *    client decides whether the effect happened; the supervisor refuses to guess.
 *
 * Persistence is an append-only JSONL log replayed at startup, so the invariant
 * survives a supervisor restart. A command whose last logged op is `begin`
 * (no `complete`/`abort`) is exactly the "uncertain" case after a crash.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentClientId, AgentCommandId, AgentControlResult } from "./control-protocol";

type JournalRecordState = "pending" | "done";

interface JournalRecord {
	state: JournalRecordState;
	result?: AgentControlResult;
	updatedAt: number;
}

type JournalLogLine =
	| { op: "begin"; key: string; at: number }
	| { op: "complete"; key: string; result: AgentControlResult; at: number }
	| { op: "abort"; key: string; at: number };

/** Outcome of {@link CommandJournal.begin}. */
export type JournalAdmission =
	/** First sighting; caller must dispatch and then call complete()/abort(). */
	| { status: "fresh" }
	/** Command already completed; return this recorded result without dispatching. */
	| { status: "replay"; result: AgentControlResult }
	/** Command began but never certainly finished; report uncertain, do NOT dispatch. */
	| { status: "uncertain" };

/** Rewrite (compact) the log once it grows past this many lines. */
const COMPACT_AFTER_LINES = 20_000;

function journalKey(clientId: AgentClientId, commandId: AgentCommandId): string {
	return `${clientId}\u0000${commandId}`;
}

export class CommandJournal {
	readonly #records = new Map<string, JournalRecord>();
	readonly #filePath?: string;
	#lineCount = 0;

	constructor(filePath?: string) {
		this.#filePath = filePath;
		if (filePath) this.#load(filePath);
	}

	/**
	 * Admit a mutating command. Records a `pending` entry on first sighting.
	 * Read-only commands must not be routed through the journal (callers gate on
	 * {@link isMutatingAgentCommand}).
	 */
	begin(clientId: AgentClientId, commandId: AgentCommandId): JournalAdmission {
		const key = journalKey(clientId, commandId);
		const existing = this.#records.get(key);
		if (existing) {
			if (existing.state === "done" && existing.result) return { status: "replay", result: existing.result };
			return { status: "uncertain" };
		}
		this.#records.set(key, { state: "pending", updatedAt: Date.now() });
		this.#append({ op: "begin", key, at: Date.now() });
		return { status: "fresh" };
	}

	/** Record a certain result for an in-flight command. */
	complete(clientId: AgentClientId, commandId: AgentCommandId, result: AgentControlResult): void {
		const key = journalKey(clientId, commandId);
		this.#records.set(key, { state: "done", result, updatedAt: Date.now() });
		this.#append({ op: "complete", key, result, at: Date.now() });
	}

	/**
	 * Drop a pending entry when the command was rejected BEFORE any side effect
	 * (e.g. failed validation), so a corrected retry can proceed. Never call this
	 * for a command whose effect is uncertain — leave it pending so a replay is
	 * reported uncertain.
	 */
	abort(clientId: AgentClientId, commandId: AgentCommandId): void {
		const key = journalKey(clientId, commandId);
		this.#records.delete(key);
		this.#append({ op: "abort", key, at: Date.now() });
	}

	/** Test/inspection helper: current state of a key, if any. */
	peek(clientId: AgentClientId, commandId: AgentCommandId): JournalRecordState | undefined {
		return this.#records.get(journalKey(clientId, commandId))?.state;
	}

	#append(line: JournalLogLine): void {
		if (!this.#filePath) return;
		try {
			appendFileSync(this.#filePath, `${JSON.stringify(line)}\n`);
			this.#lineCount++;
			if (this.#lineCount > COMPACT_AFTER_LINES) this.#compact();
		} catch (error) {
			logger.warn("Command journal append failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#compact(): void {
		if (!this.#filePath) return;
		const lines: string[] = [];
		for (const [key, record] of this.#records) {
			if (record.state === "done" && record.result) {
				lines.push(JSON.stringify({ op: "complete", key, result: record.result, at: record.updatedAt }));
			} else if (record.state === "pending") {
				lines.push(JSON.stringify({ op: "begin", key, at: record.updatedAt }));
			}
		}
		const tmp = `${this.#filePath}.tmp-${process.pid}`;
		writeFileSync(tmp, lines.length ? `${lines.join("\n")}\n` : "");
		renameSync(tmp, this.#filePath);
		this.#lineCount = lines.length;
	}

	#load(filePath: string): void {
		mkdirSync(dirname(filePath), { recursive: true });
		let text: string;
		try {
			text = readFileSync(filePath, "utf8");
		} catch {
			return;
		}
		for (const raw of text.split("\n")) {
			if (!raw) continue;
			this.#lineCount++;
			let line: JournalLogLine;
			try {
				line = JSON.parse(raw) as JournalLogLine;
			} catch {
				continue;
			}
			if (line.op === "begin") {
				this.#records.set(line.key, { state: "pending", updatedAt: line.at });
			} else if (line.op === "complete") {
				this.#records.set(line.key, { state: "done", result: line.result, updatedAt: line.at });
			} else {
				this.#records.delete(line.key);
			}
		}
	}
}
