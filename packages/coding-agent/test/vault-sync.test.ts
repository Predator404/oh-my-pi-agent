import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { syncVaultMnemopi } from "../src/vault-mcp/sync";

describe("syncVaultMnemopi bidirectional sync", () => {
	let tempDir: string;
	let vaultRoot: string;

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-sync-test-"));
		vaultRoot = path.join(tempDir, "vault");
		await fs.mkdir(path.join(vaultRoot, "personas", "phi"), { recursive: true });
		await fs.mkdir(path.join(vaultRoot, "projects", "my-project"), { recursive: true });
		await fs.mkdir(path.join(vaultRoot, "reference"), { recursive: true });

		// Sample note 1
		await fs.writeFile(
			path.join(vaultRoot, "personas", "phi", "architecture.md"),
			`# Architecture Overview\n\nThis is the core architecture.\n\n## Subsystem\n\nDetails of the subsystem.`,
			"utf8",
		);

		// Sample note 2
		await fs.writeFile(
			path.join(vaultRoot, "projects", "my-project", "README.md"),
			`# My Project\n\nProject guidelines and goals.`,
			"utf8",
		);
	});

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("runs dry-run sync without making writes", async () => {
		const result = await syncVaultMnemopi({
			vaultRoot,
			bank: "test-phi",
			noEmbeddings: true,
			dryRun: true,
		});

		expect(result.errors).toEqual([]);
		expect(result.imported).toBeGreaterThan(0);
		expect(result.exported).toBe(0);
	});

	it("imports markdown notes into mnemopi bank and exports learned memories", async () => {
		const result = await syncVaultMnemopi({
			vaultRoot,
			bank: "test-phi",
			noEmbeddings: true,
		});

		expect(result.errors).toEqual([]);
		expect(result.imported).toBeGreaterThan(0);

		// Re-running sync should complete cleanly
		const rerun = await syncVaultMnemopi({
			vaultRoot,
			bank: "test-phi",
			noEmbeddings: true,
		});
		expect(rerun.errors).toEqual([]);
	});

	it("chunks heading-less documents into size-capped blocks", async () => {
		const longText = "A".repeat(3000);
		await fs.writeFile(path.join(vaultRoot, "reference", "long-doc.md"), longText, "utf8");

		const result = await syncVaultMnemopi({
			vaultRoot,
			bank: "test-phi-chunks",
			noEmbeddings: true,
			dryRun: true,
		});

		expect(result.errors).toEqual([]);
		expect(result.imported).toBeGreaterThan(2);
	});

	it("skips export directory without skipping sibling files", async () => {
		await fs.mkdir(path.join(vaultRoot, "personas", "phi", "learned"), { recursive: true });
		await fs.writeFile(
			path.join(vaultRoot, "personas", "phi", "learned", "exported.md"),
			"# Exported\n\nExported lesson.",
			"utf8",
		);
		await fs.writeFile(
			path.join(vaultRoot, "personas", "phi", "learned-sibling.md"),
			"# Sibling\n\nSibling note.",
			"utf8",
		);

		const result = await syncVaultMnemopi({
			vaultRoot,
			bank: "test-phi-siblings",
			noEmbeddings: true,
			dryRun: true,
		});

		expect(result.errors).toEqual([]);
	});
});
