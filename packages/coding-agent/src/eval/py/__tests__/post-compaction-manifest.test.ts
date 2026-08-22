import { describe, expect, test } from "bun:test";
import type { AutoCompactionEndEvent } from "../../../extensibility/shared-events";
import { handleAutoCompactionEndManifest, type ManifestInjectionSession } from "../post-compaction-manifest";

const SENTINEL_BEGIN = "<<<OMP_STATE_MANIFEST_BEGIN>>>";
const SENTINEL_END = "<<<OMP_STATE_MANIFEST_END>>>";

interface AppendedMessage {
	role: "developer";
	content: string;
	attribution: "agent";
	timestamp: number;
}

/**
 * Fake session recording introspection cells and injected developer messages.
 * `pythonOutput` scripts the introspection result; a function form lets a case
 * make `executePython` throw.
 */
class FakeSession implements ManifestInjectionSession {
	readonly executePythonCalls: string[] = [];
	readonly appended: AppendedMessage[] = [];
	readonly agent = { appendMessage: (message: AppendedMessage) => void this.appended.push(message) };

	#pythonOutput: string | (() => never);

	constructor(pythonOutput: string | (() => never)) {
		this.#pythonOutput = pythonOutput;
	}

	getEvalKernelOwnerId(): string {
		return "owner-1";
	}

	async executePython(
		code: string,
		_onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<{ output: string }> {
		this.executePythonCalls.push(code);
		// The introspection cell must always be excluded from context so it can
		// never trigger recursion/compaction.
		expect(options?.excludeFromContext).toBe(true);
		if (typeof this.#pythonOutput === "function") return { output: this.#pythonOutput() };
		return { output: this.#pythonOutput };
	}
}

function manifestOutput(rows: unknown[]): string {
	return `${SENTINEL_BEGIN}${JSON.stringify(rows)}${SENTINEL_END}\n`;
}

const successEvent: AutoCompactionEndEvent = {
	type: "auto_compaction_end",
	action: "context-full",
	result: { keptMessages: 1 } as unknown as AutoCompactionEndEvent["result"],
	aborted: false,
	willRetry: false,
	skipped: false,
};

describe("handleAutoCompactionEndManifest", () => {
	test("injects a developer manifest on success with a live kernel", async () => {
		const session = new FakeSession(manifestOutput([{ name: "df", type: "DataFrame", repr: "<df>", size: 100 }]));

		await handleAutoCompactionEndManifest(session, successEvent, { hasLiveKernel: () => true });

		expect(session.executePythonCalls).toHaveLength(1);
		expect(session.appended).toHaveLength(1);
		const message = session.appended[0];
		expect(message.role).toBe("developer");
		expect(message.attribution).toBe("agent");
		expect(message.content).toContain("df: DataFrame");
		// Framing preamble precedes the rendered manifest.
		expect(message.content).toContain("was NOT reset");
	});

	test("injects when the optional `skipped` field is omitted (real events may not set it)", async () => {
		// Upstream declares `skipped?: boolean` optional; production auto_compaction_end
		// events can omit it. The gate must treat an absent `skipped` as not-skipped
		// (`!undefined`), so a bare successful compaction still injects. Pins against a
		// future rewrite to `event.skipped === false` that would drop real injections.
		const { skipped: _omit, ...eventWithoutSkipped } = successEvent;
		const session = new FakeSession(manifestOutput([{ name: "df", type: "DataFrame", repr: "<df>", size: 100 }]));

		await handleAutoCompactionEndManifest(session, eventWithoutSkipped as AutoCompactionEndEvent, {
			hasLiveKernel: () => true,
		});

		expect(session.executePythonCalls).toHaveLength(1);
		expect(session.appended).toHaveLength(1);
	});

	test("no injection and no introspection when no live kernel exists", async () => {
		const session = new FakeSession(manifestOutput([{ name: "df", type: "DataFrame", repr: "<df>" }]));

		await handleAutoCompactionEndManifest(session, successEvent, { hasLiveKernel: () => false });

		expect(session.executePythonCalls).toHaveLength(0);
		expect(session.appended).toHaveLength(0);
	});

	test("no injection when the kernel holds no user state (empty manifest)", async () => {
		const session = new FakeSession(manifestOutput([]));

		await handleAutoCompactionEndManifest(session, successEvent, { hasLiveKernel: () => true });

		expect(session.executePythonCalls).toHaveLength(1);
		expect(session.appended).toHaveLength(0);
	});

	test("swallows an executePython throw without escaping the handler", async () => {
		const session = new FakeSession(() => {
			throw new Error("kernel died");
		});

		await expect(
			handleAutoCompactionEndManifest(session, successEvent, { hasLiveKernel: () => true }),
		).resolves.toBeUndefined();
		expect(session.appended).toHaveLength(0);
	});

	test.each([
		["aborted", { ...successEvent, aborted: true }],
		["willRetry", { ...successEvent, willRetry: true }],
		["skipped", { ...successEvent, skipped: true }],
		["no result", { ...successEvent, result: undefined }],
	])("gate rejects %s: no introspection, no injection", async (_label, event) => {
		const session = new FakeSession(manifestOutput([{ name: "df", type: "DataFrame", repr: "<df>" }]));

		await handleAutoCompactionEndManifest(session, event as AutoCompactionEndEvent, {
			hasLiveKernel: () => true,
		});

		expect(session.executePythonCalls).toHaveLength(0);
		expect(session.appended).toHaveLength(0);
	});
});
