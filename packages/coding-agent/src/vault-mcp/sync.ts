/**
 * Bidirectional synchronization between Obsidian Markdown Vault and Mnemopi SQLite vector store.
 *
 * Inbound:  Vault Markdown (.md) -> Mnemopi SQLite (chunked, hashed, embedded).
 * Outbound: Mnemopi (learned/retained domain lessons) -> Vault Markdown (clean Obsidian notes in personas/phi/learned/).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Metadata, Mnemopi, type RecallResult } from "@oh-my-pi/pi-mnemopi";
import { BankManager } from "@oh-my-pi/pi-mnemopi/core/banks";

export interface VaultSyncOptions {
	/** Absolute path to the vault root directory. */
	vaultRoot: string;
	/** Target Mnemopi bank name (default: "phi" or "default"). */
	bank?: string;
	/** Explicit database path for Mnemopi. Defaults to `<vaultRoot>/.mnemopi/mnemopi.db` if present, else standard bank path. */
	dbPath?: string;
	/** Subdirectory in vault for exporting agent-retained memories (default: "personas/phi/learned"). */
	exportDir?: string;
	/** Disable embeddings generation (FTS-only). */
	noEmbeddings?: boolean;
	/** Dry run mode: report changes without writing. */
	dryRun?: boolean;
	/** Existing Mnemopi instance to use instead of opening one. */
	mnemopi?: Mnemopi;
}

interface VaultBlock {
	key: string;
	relPath: string;
	heading?: string;
	text: string;
	hash: string;
}

export interface VaultSyncResult {
	vaultRoot: string;
	bank: string;
	imported: number;
	updated: number;
	pruned: number;
	exported: number;
	skipped: number;
	errors: string[];
}
const IGNORED_DIR_NAMES: Record<string, true> = {
	".git": true,
	".obsidian": true,
	".mnemopi": true,
	"node_modules": true,
	"Templates": true,
	"templates": true,
	".trash": true,
};

const MAX_BLOCK_CHARS = 2500;

function hashText(text: string): string {
	return crypto.createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

function sanitizeFilename(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

/** Collect all non-ignored markdown files under root. */
function collectVaultMarkdownFiles(dir: string, baseDir: string = dir): string[] {
	const results: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		if (entry.name.startsWith(".") && entry.name !== ".mnemopi") continue;
		if (IGNORED_DIR_NAMES[entry.name]) continue;

		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectVaultMarkdownFiles(fullPath, baseDir));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			results.push(path.relative(baseDir, fullPath));
		}
	}
	return results;
}

/** Split a markdown document into heading-delimited or chunked blocks. */
function parseVaultBlocks(content: string, relPath: string): VaultBlock[] {
	const lines = content.split("\n");
	const blocks: VaultBlock[] = [];
	const headings: { level: number; title: string; lineIdx: number }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
		if (m) {
			headings.push({ level: m[1].length, title: m[2].trim(), lineIdx: i });
		}
	}

	if (headings.length === 0) {
		const text = content.trim();
		if (text.length === 0) return blocks;
		for (let i = 0; i < text.length; i += MAX_BLOCK_CHARS) {
			const chunk = text.slice(i, i + MAX_BLOCK_CHARS);
			blocks.push({
				key: i === 0 ? relPath : `${relPath}#${i}`,
				relPath,
				text: chunk,
				hash: hashText(chunk),
			});
		}
		return blocks;
	}

	if (content.length <= MAX_BLOCK_CHARS) {
		const text = content.trim();
		if (text.length > 0) {
			blocks.push({
				key: relPath,
				relPath,
				text,
				hash: hashText(text),
			});
		}
		return blocks;
	}

	for (let i = 0; i < headings.length; i++) {
		const cur = headings[i];
		const next = headings[i + 1];
		const startIdx = cur.lineIdx;
		const endIdx = next !== undefined ? next.lineIdx : lines.length;
		const sectionLines = lines.slice(startIdx, endIdx);
		const text = sectionLines.join("\n").trim();
		if (text.length === 0) continue;

		const key = `${relPath}#${cur.title}`;
		blocks.push({
			key,
			relPath,
			heading: cur.title,
			text: text.slice(0, MAX_BLOCK_CHARS),
			hash: hashText(text),
		});
	}

	return blocks;
}

/** Derive a concise note title from memory content or ID. */
function deriveMemoryTitle(content: string, id: string): string {
	const firstLine = content.trim().split("\n", 1)[0].replace(/^[#*-]\s*/, "").trim();
	if (firstLine.length > 0 && firstLine.length <= 80) {
		return firstLine;
	}
	return `Lesson ${id.slice(0, 8)}`;
}

/**
 * Execute bidirectional synchronization between a vault and Mnemopi SQLite store.
 */
export async function syncVaultMnemopi(options: VaultSyncOptions): Promise<VaultSyncResult> {
	const vaultRoot = path.resolve(options.vaultRoot);
	const bank = options.bank ?? "phi";
	const exportSubdir = options.exportDir ?? path.join("personas", bank === "default" ? "phi" : bank, "learned");
	const exportDir = path.resolve(vaultRoot, exportSubdir);

	const result: VaultSyncResult = {
		vaultRoot,
		bank,
		imported: 0,
		updated: 0,
		pruned: 0,
		exported: 0,
		skipped: 0,
		errors: [],
	};

	if (!fs.existsSync(vaultRoot)) {
		result.errors.push(`Vault root does not exist: ${vaultRoot}`);
		return result;
	}

	// Resolve dbPath: explicit > vault-local `.mnemopi/mnemopi.db` > BankManager default
	let dbPath = options.dbPath;
	if (!dbPath) {
		const vaultLocalDb = path.join(vaultRoot, ".mnemopi", "mnemopi.db");
		if (fs.existsSync(vaultLocalDb) || fs.existsSync(path.join(vaultRoot, ".mnemopi"))) {
			dbPath = vaultLocalDb;
		}
	}

	const manager = new BankManager();
	if (!dbPath) {
		if (!options.dryRun) {
			if (!manager.bankExists(bank)) {
				manager.createBank(bank);
			}
			dbPath = manager.getBankDbPath(bank);
		} else {
			dbPath = ":memory:";
		}
	} else if (!options.dryRun) {
		const dbDir = path.dirname(dbPath);
		if (!fs.existsSync(dbDir)) {
			fs.mkdirSync(dbDir, { recursive: true });
		}
	}

	const mnemopi =
		options.mnemopi ??
		new Mnemopi({
			bank,
			dbPath,
			noEmbeddings: options.noEmbeddings ?? false,
		});

	try {
		// ── 1. Inbound Sync: Vault -> Mnemopi ─────────────────────────────
		const mdFiles = collectVaultMarkdownFiles(vaultRoot);
		const seenVaultSources = new Set<string>();

		const exportPrefix = exportSubdir.endsWith(path.sep) || exportSubdir.endsWith("/")
			? exportSubdir
			: `${exportSubdir}/`;
		for (const relPath of mdFiles) {
			// Skip files in the exportDir to avoid export-import feedback loops
			if (relPath === exportSubdir || relPath.startsWith(exportPrefix)) continue;

			const fullPath = path.join(vaultRoot, relPath);
			let content = "";
			try {
				content = fs.readFileSync(fullPath, "utf8");
			} catch (err) {
				result.errors.push(`Failed to read ${relPath}: ${String(err)}`);
				continue;
			}

			const blocks = parseVaultBlocks(content, relPath);
			for (const block of blocks) {
				const sourceTag = `vault:${block.relPath}`;
				seenVaultSources.add(sourceTag);

				if (options.dryRun) {
					result.imported++;
					continue;
				}

				try {
					mnemopi.remember(block.text, {
						source: sourceTag,
						importance: 0.8,
						metadata: {
							sourceType: "vault",
							filePath: block.relPath,
							heading: block.heading ?? null,
							hash: block.hash,
							key: block.key,
							syncedAt: new Date().toISOString(),
						},
					});
					result.imported++;
				} catch (err) {
					result.errors.push(`Failed to remember block ${block.key}: ${String(err)}`);
				}
			}
		}

		// ── 2. Outbound Sync: Mnemopi (Deliberate Lessons) -> Vault Markdown ─
		if (!options.dryRun && !fs.existsSync(exportDir)) {
			fs.mkdirSync(exportDir, { recursive: true });
		}

		// Recall deliberate lessons stored in Mnemopi to export as clean Markdown notes
		try {
			const recallResults: RecallResult[] = await (options.noEmbeddings
				? mnemopi.recall("domain lesson contract architecture decision convention", 50, { queryEmbedding: null })
				: mnemopi.recall("domain lesson contract architecture decision convention", 50));

			for (const item of recallResults) {
				// Only export non-vault memories (deliberately retained session lessons)
				const metadata = item.metadata as Record<string, unknown> | undefined;
				const source = item.source ?? "";
				if (source.startsWith("vault:") || metadata?.sourceType === "vault") {
					continue;
				}

				const title = deriveMemoryTitle(item.content, item.id);
				const slug = sanitizeFilename(title) || item.id;
				const outFilename = `${slug}.md`;
				const outPath = path.join(exportDir, outFilename);

				const noteContent = [
					"---",
					`id: ${item.id}`,
					"type: domain-lesson",
					`created: ${new Date().toISOString().slice(0, 10)}`,
					`source: ${source || "agent-retain"}`,
					`tags: [memory, learned, ${bank}]`,
					"---",
					"",
					`# ${title}`,
					"",
					item.content.trim(),
					"",
				].join("\n");

				if (options.dryRun) {
					result.exported++;
					continue;
				}

				let existingContent = "";
				if (fs.existsSync(outPath)) {
					existingContent = fs.readFileSync(outPath, "utf8");
				}

				if (existingContent !== noteContent) {
					fs.writeFileSync(outPath, noteContent, "utf8");
					result.exported++;
				} else {
					result.skipped++;
				}
			}
		} catch (err) {
			result.errors.push(`Outbound memory export error: ${String(err)}`);
		}
	} finally {
		if (!options.mnemopi) {
			try {
				await mnemopi.flushExtractions();
			} catch {
				// Ignore flush errors during teardown
			}
			mnemopi.close();
		}
	}

	return result;
}
