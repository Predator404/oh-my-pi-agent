/**
 * WS7 — entity-record authoring (create/patch). Proves validated writes, honest
 * `created` semantics (fresh vs forced overwrite), no-clobber default, policy
 * enforcement, and body-preserving frontmatter patches.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseEntityRecord } from "@oh-my-pi/pi-coding-agent/entity/loader";
import { createEntityRecord, updateEntityRecordFields } from "@oh-my-pi/pi-coding-agent/entity/record-writer";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";

let root: string;
let registryRoot: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ws7-writer-"));
	registryRoot = path.join(root, "reg");
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const persona = { role: "persona" as const, description: "A specialist", systemPrompt: "You are a specialist." };

describe("createEntityRecord", () => {
	it("writes a validated, re-parseable record and reports created:true", async () => {
		const result = await createEntityRecord(
			"sage",
			{ ...persona, model: ["anthropic/opus"], tools: ["read", "grep"] },
			{ registryRoot },
		);
		expect(result.created).toBe(true);
		const content = await fs.readFile(result.filePath, "utf8");
		const parsed = parseEntityRecord(result.filePath, content, "user");
		expect(parsed.name).toBe("sage");
		expect(parsed.role).toBe("persona");
		expect(parsed.model).toEqual(["anthropic/opus"]);
		expect(parsed.vaultSection).toBe("personas/sage"); // defaulted
		expect(parsed.memory.bank).toBe("sage"); // defaulted to name
	});

	it("refuses to overwrite without force", async () => {
		await createEntityRecord("dup", persona, { registryRoot });
		expect(createEntityRecord("dup", persona, { registryRoot })).rejects.toThrow(/already exists/);
	});

	it("forced overwrite reports created:false (not a fresh create)", async () => {
		await createEntityRecord("edit", persona, { registryRoot });
		const result = await createEntityRecord(
			"edit",
			{ ...persona, description: "Rewritten" },
			{ registryRoot, force: true },
		);
		expect(result.created).toBe(false);
		const parsed = parseEntityRecord(result.filePath, await fs.readFile(result.filePath, "utf8"), "user");
		expect(parsed.description).toBe("Rewritten");
	});

	it("enforces the persona retention policy (autoRetain rejected)", async () => {
		expect(createEntityRecord("bad", { ...persona, memory: { autoRetain: true } }, { registryRoot })).rejects.toThrow(
			/curated-only|autoRetain/,
		);
	});

	it("writes a private-registry record with a correctly namespaced bank", async () => {
		const secretRoot = path.join(root, "secret");
		const manifestPath = path.join(root, "registries.json");
		await fs.writeFile(
			manifestPath,
			JSON.stringify({
				oma: { root: path.join(root, "oma"), visibility: "public" },
				secret: { root: secretRoot, visibility: "private" },
			}),
			"utf8",
		);
		const result = await createEntityRecord(
			"phi",
			{ ...persona, memory: { bank: "secret/phi" } },
			{ registry: "secret", manifestPath },
		);
		expect(result.created).toBe(true);
		expect(result.filePath).toBe(path.join(secretRoot, "entities", "phi.md"));
		const parsed = parseEntityRecord(result.filePath, await fs.readFile(result.filePath, "utf8"), "user", "secret");
		expect(parsed.memory.bank).toBe("secret/phi");
	});

	it("rejects a private-registry record whose bank is not namespaced", async () => {
		const secretRoot = path.join(root, "secret2");
		const manifestPath = path.join(root, "registries2.json");
		await fs.writeFile(manifestPath, JSON.stringify({ secret: { root: secretRoot, visibility: "private" } }), "utf8");
		expect(
			createEntityRecord("phi", { ...persona, memory: { bank: "phi" } }, { registry: "secret", manifestPath }),
		).rejects.toThrow(/must be namespaced/);
	});
});

describe("updateEntityRecordFields", () => {
	it("patches frontmatter, preserves the prompt body, and re-validates", async () => {
		await createEntityRecord("phi", { ...persona, systemPrompt: "Original prompt body." }, { registryRoot });
		const result = await updateEntityRecordFields(
			"phi",
			[
				{ key: "model", value: "anthropic/opus,anthropic/sonnet" },
				{ key: "thinking", value: "high" },
				{ key: "memory.bank", value: "phi-bank" },
			],
			{ registryRoot },
		);
		expect(result.created).toBe(false);
		const parsed = parseEntityRecord(result.filePath, await fs.readFile(result.filePath, "utf8"), "user");
		expect(parsed.model).toEqual(["anthropic/opus", "anthropic/sonnet"]);
		expect(parsed.thinkingLevel).toBe("high" as ConfiguredThinkingLevel);
		expect(parsed.memory.bank).toBe("phi-bank");
		expect(parsed.systemPrompt).toBe("Original prompt body."); // body preserved verbatim
	});

	it("rejects an unknown field and a missing record", async () => {
		await createEntityRecord("who", persona, { registryRoot });
		expect(updateEntityRecordFields("who", [{ key: "nonsense", value: "x" }], { registryRoot })).rejects.toThrow(
			/Unknown entity field/,
		);
		expect(updateEntityRecordFields("ghost", [{ key: "thinking", value: "high" }], { registryRoot })).rejects.toThrow(
			/No entity record/,
		);
	});

	it("rejects a patch that would violate the retention policy", async () => {
		await createEntityRecord("strict", persona, { registryRoot });
		expect(
			updateEntityRecordFields("strict", [{ key: "memory.autoRetain", value: "true" }], { registryRoot }),
		).rejects.toThrow(/curated-only|autoRetain/);
	});
});
