import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSessionLease, SessionAlreadyActiveError } from "../session-lease";

describe("session lease", () => {
	let agentDir: string;
	let sessionPath: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "omp-lease-"));
		sessionPath = join(agentDir, "session.jsonl");
		writeFileSync(sessionPath, "");
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	test("acquires an uncontended lease", () => {
		const lease = acquireSessionLease(sessionPath, agentDir, { ownerId: "s1" });
		expect(lease.sessionPath).toContain("session.jsonl");
		lease.release();
	});

	test("a second live acquire on the same session throws SessionAlreadyActiveError", () => {
		const first = acquireSessionLease(sessionPath, agentDir, { ownerId: "s1" });
		try {
			expect(() => acquireSessionLease(sessionPath, agentDir, { ownerId: "s2" })).toThrow(SessionAlreadyActiveError);
		} finally {
			first.release();
		}
	});

	test("carries the prior owner id on conflict", () => {
		const first = acquireSessionLease(sessionPath, agentDir, { ownerId: "owner-A" });
		try {
			acquireSessionLease(sessionPath, agentDir, { ownerId: "owner-B" });
			throw new Error("expected conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(SessionAlreadyActiveError);
			expect((error as SessionAlreadyActiveError).activeSessionId).toBe("owner-A");
		} finally {
			first.release();
		}
	});

	test("re-acquire succeeds once the lease is released", () => {
		acquireSessionLease(sessionPath, agentDir, { ownerId: "s1" }).release();
		const second = acquireSessionLease(sessionPath, agentDir, { ownerId: "s2" });
		expect(second.sessionPath).toContain("session.jsonl");
		second.release();
	});

	test("distinct sessions hold independent leases", () => {
		const other = join(agentDir, "other.jsonl");
		writeFileSync(other, "");
		const a = acquireSessionLease(sessionPath, agentDir, { ownerId: "a" });
		const b = acquireSessionLease(other, agentDir, { ownerId: "b" });
		expect(a.sessionPath).not.toBe(b.sessionPath);
		a.release();
		b.release();
	});
});
