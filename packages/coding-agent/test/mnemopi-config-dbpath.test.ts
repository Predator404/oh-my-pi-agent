import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";

// Regression coverage for issue #9360: a blank `mnemopi.dbPath` must fall back to
// the default agent memories path. A surviving empty string makes bun:sqlite open an
// in-memory bank, silently discarding memories across sessions.
const AGENT_DIR = "/tmp/mnemopi-config-dbpath-test";

function dbPathFor(overrides: Record<string, unknown>): string {
	const settings = Settings.isolated({ "mnemopi.scoping": "global", ...overrides });
	return loadMnemopiConfig(settings, AGENT_DIR).dbPath;
}

const DEFAULT_DB_PATH = path.join(getMemoriesDir(AGENT_DIR), "mnemopi", "mnemopi.db");

describe("loadMnemopiConfig dbPath resolution", () => {
	it("does not let an empty-string dbPath survive as an in-memory bank", () => {
		expect(dbPathFor({ "mnemopi.dbPath": "" })).toBe(DEFAULT_DB_PATH);
	});

	it("does not let a whitespace-only dbPath survive as an in-memory bank", () => {
		expect(dbPathFor({ "mnemopi.dbPath": "   " })).toBe(DEFAULT_DB_PATH);
	});

	it("returns an explicit absolute dbPath unchanged", () => {
		const configured = "/var/data/custom-mnemopi.db";
		expect(dbPathFor({ "mnemopi.dbPath": configured })).toBe(configured);
	});
});
