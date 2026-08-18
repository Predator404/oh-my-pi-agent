/**
 * Bank-scoped memory store — the multi-bank core of the C2 memory MCP server
 * (SPEC §4.2, §12.3).
 *
 * OMP natively binds exactly one `memory.backend` per AgentSession, so a single
 * running context cannot address two banks at once — the gap this server exists
 * to close. mnemopi's module-level `recall`/`remember`/`forget` do not help:
 * they route through one cached `defaultInstance` that is *closed and replaced*
 * whenever the bank changes (`core/memory.ts#defaultFor`), so two entities on
 * distinct banks would tear down each other's database on every call.
 *
 * `BankStore` instead keeps one long-lived {@link Mnemopi} per bank in a map,
 * each holding its own SQLite connection to its own bank file. Distinct banks
 * are fully independent (separate files, separate connections), so two entities
 * can recall/retain against distinct banks concurrently from one process with
 * no cross-close and no lock contention.
 *
 * Every {@link Mnemopi} is opened with an explicit `dbPath` computed from this
 * store's own {@link BankManager}, so two stores with different data dirs can
 * coexist in one process without clobbering shared state (no `process.env`
 * mutation). Provisioning a bank's files happens only on the write path
 * ({@link BankStore.retain}); reads against a bank that was never created return
 * empty rather than silently materializing an empty bank.
 */
import { type Metadata, Mnemopi, type RecallResult } from "@oh-my-pi/pi-mnemopi";
import { BankManager } from "@oh-my-pi/pi-mnemopi/core/banks";

/** How a retained memory reached the store — stamped as its `source`. */
export type RetainMode = "deliberate" | "auto";

export interface BankStoreOptions {
	/**
	 * Disable the embedding pipeline. Recall becomes FTS-only (no network) and
	 * retain skips embedding. Used for offline/local-first deployments and tests;
	 * production leaves it off so mnemopi's configured embedder runs.
	 */
	noEmbeddings?: boolean;
	/**
	 * Override the mnemopi data dir (bank files live under `<dataDir>/banks/`).
	 * Defaults to mnemopi's configured dir (`MNEMOPI_DATA_DIR` or the built-in
	 * default). Threaded into every bank's explicit `dbPath`, so it never mutates
	 * process-global state.
	 */
	dataDir?: string;
}

export interface RetainOptions {
	/** Surrounding context stored alongside the memory (metadata `context`). */
	context?: string;
	/** Distinguishes curated (deliberate) writes from episodic (auto) capture. */
	mode?: RetainMode;
	/** Importance 0..1; defaults to mnemopi's 0.5. */
	importance?: number;
}

/**
 * One live {@link Mnemopi} per bank. All methods take an explicit `bank` — the
 * bank argument is authoritative, which is exactly what lets one context serve
 * many banks at once.
 */
export class BankStore {
	readonly #instances = new Map<string, Mnemopi>();
	readonly #manager: BankManager;
	readonly #noEmbeddings: boolean;
	#closed = false;

	constructor(options: BankStoreOptions = {}) {
		this.#noEmbeddings = options.noEmbeddings ?? false;
		this.#manager = new BankManager(options.dataDir);
	}

	/**
	 * The long-lived {@link Mnemopi} bound to `bank`. When `create` is false and
	 * the bank has never been provisioned, returns `undefined` (read ops must not
	 * materialize an empty bank). Synchronous: no `await` between the existence
	 * check and the cache insert, so concurrent same-bank callers never double
	 * create. Each instance is opened with an explicit `dbPath` from this store's
	 * manager — never via mnemopi's env-derived default.
	 */
	#resolve(bank: string, create: boolean): Mnemopi | undefined {
		if (this.#closed) throw new Error("BankStore is closed");
		const cached = this.#instances.get(bank);
		if (cached !== undefined) return cached;
		if (!this.#manager.bankExists(bank)) {
			if (!create) return undefined;
			// `createBank` validates the name and provisions `<banks>/<bank>/…`;
			// without it, opening a fresh bank's SQLite file would fail (missing dir).
			this.#manager.createBank(bank);
		}
		const instance = new Mnemopi({
			bank,
			dbPath: this.#manager.getBankDbPath(bank),
			noEmbeddings: this.#noEmbeddings,
		});
		this.#instances.set(bank, instance);
		return instance;
	}

	/** Banks with a live instance in this store. */
	openBanks(): string[] {
		return [...this.#instances.keys()];
	}

	/** Scoped semantic recall against one bank; empty for a never-provisioned bank. */
	recall(bank: string, query: string, k = 5): Promise<RecallResult[]> {
		const instance = this.#resolve(bank, false);
		if (instance === undefined) return Promise.resolve([]);
		// `queryEmbedding: null` is mnemopi's explicit FTS-only opt-out; used only
		// when embeddings are disabled so recall never reaches for a network embedder.
		return this.#noEmbeddings ? instance.recall(query, k, { queryEmbedding: null }) : instance.recall(query, k);
	}

	/** Write a memory into one bank (provisioning it if new); returns the new id. */
	retain(bank: string, memory: string, options: RetainOptions = {}): string {
		const instance = this.#resolve(bank, true);
		if (instance === undefined) throw new Error(`Failed to open memory bank "${bank}"`);
		const mode: RetainMode = options.mode ?? "deliberate";
		const metadata: Metadata = { retainMode: mode };
		if (options.context !== undefined && options.context.length > 0) metadata.context = options.context;
		return instance.remember(memory, {
			source: mode === "auto" ? "auto-retain" : "deliberate",
			importance: options.importance ?? 0.5,
			metadata,
		});
	}

	/** Remove a memory from one bank; `false` for a never-provisioned bank. */
	forget(bank: string, id: string): boolean {
		const instance = this.#resolve(bank, false);
		return instance === undefined ? false : instance.forget(id);
	}

	/** Close every open bank connection. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const instance of this.#instances.values()) instance.close();
		this.#instances.clear();
	}
}
