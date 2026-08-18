/**
 * Bank retention-policy registry — resolves the agent-vs-persona write policy
 * from the C1 entity registry (contract C1 → C2 seam, SPEC §4.1, §4.2, §12.3).
 *
 * Bank binding resolves from a C1 record's `memory` block: `memory.bank` is the
 * bank an entity addresses, and `memory.autoRetain` is its retention switch.
 * The C1 loader already enforces that only `role: agent` may carry
 * `autoRetain: true` (a `persona` is curated-only, rejected at load), so this
 * registry can trust the flag verbatim and simply aggregate it per bank.
 *
 * Enforcement lives at the write path (the memory MCP server): an `auto`
 * (episodic) write is permitted only when the target bank is auto-retainable;
 * `deliberate` writes are always allowed, which is how a persona still curates
 * lessons on explicit calls. A rejection distinguishes three genuinely
 * different conditions — a curated-only bank, a bank no entity binds, and a
 * registry that resolved nothing (usually a misconfigured `OMP_ENTITY_REGISTRY`)
 * — so an operator is never told "bank policy forbids this" when the real cause
 * is that no policy loaded at all.
 */
import { discoverEntities, type EntityLoadError, type EntityRegistryOptions } from "../entity";

/** Aggregated retention policy for one bank. */
export interface BankPolicy {
	bank: string;
	/**
	 * Whether episodic (auto) writes are allowed. True only when the bank is
	 * bound by at least one entity and *every* binding permits auto-retain — a
	 * single persona binding (always `autoRetain: false`) makes the bank
	 * curated-only.
	 */
	autoRetain: boolean;
	/** Entity names binding this bank. */
	entities: string[];
}

/** Why an `auto` write was denied — each cause carries an operator-facing message. */
export type AutoRetainReason = "curated-only" | "unbound-bank" | "registry-unresolved";

export type AutoRetainDecision = { allowed: true } | { allowed: false; reason: AutoRetainReason; message: string };

/**
 * Reads the C1 roster once (lazily) and answers per-bank write-policy queries.
 * The roster scan is metadata-only (no prompt bodies), so building the map is
 * cheap and holds no eagerly-loaded prompts. Record load errors surfaced by the
 * loader are retained (not just logged) so a broken registry is diagnosable.
 */
export class BankPolicyRegistry {
	readonly #byBank = new Map<string, BankPolicy>();
	readonly #options: EntityRegistryOptions;
	#loadErrors: EntityLoadError[] = [];
	#entityCount = 0;
	#loaded = false;

	constructor(options: EntityRegistryOptions = {}) {
		this.#options = options;
	}

	/** (Re)load the bank→policy map from the entity registry. */
	async load(): Promise<void> {
		const { entities, errors } = await discoverEntities(this.#options);
		this.#byBank.clear();
		this.#loadErrors = errors;
		this.#entityCount = entities.length;
		for (const entity of entities) {
			if (entity.memory.backend !== "mnemopi") continue;
			const bank = entity.memory.bank;
			const existing = this.#byBank.get(bank);
			if (existing === undefined) {
				this.#byBank.set(bank, {
					bank,
					autoRetain: entity.memory.autoRetain,
					entities: [entity.name],
				});
			} else {
				// A bank shared by several entities is auto-retainable only if they
				// all agree; any persona binding forces curated-only.
				existing.autoRetain &&= entity.memory.autoRetain;
				existing.entities.push(entity.name);
			}
		}
		this.#loaded = true;
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) await this.load();
	}

	/**
	 * Decide whether an auto (episodic) write may target `bank`, with a reason
	 * when it may not. The three denial reasons are kept distinct so the caller
	 * never blames bank policy for a registry that failed to resolve.
	 */
	async decideAutoRetain(bank: string): Promise<AutoRetainDecision> {
		await this.#ensureLoaded();
		const policy = this.#byBank.get(bank);
		if (policy?.autoRetain) return { allowed: true };
		if (policy !== undefined) {
			return {
				allowed: false,
				reason: "curated-only",
				message:
					`Bank "${bank}" is curated-only (bound by persona ${policy.entities.join(", ")}, ` +
					`autoRetain:false); auto-retain is rejected. Only deliberate retain is permitted on this bank.`,
			};
		}
		if (this.#entityCount === 0) {
			const detail =
				this.#loadErrors.length > 0
					? `${this.#loadErrors.length} record load error(s) — check OMP_ENTITY_REGISTRY`
					: "no entity records found — check OMP_ENTITY_REGISTRY";
			return {
				allowed: false,
				reason: "registry-unresolved",
				message:
					`Auto-retain for bank "${bank}" cannot be authorized: the entity registry resolved no ` +
					`entities (${detail}). Deliberate retain still works.`,
			};
		}
		return {
			allowed: false,
			reason: "unbound-bank",
			message:
				`Bank "${bank}" is not bound by any entity in the registry; auto-retain is rejected. ` +
				`Deliberate retain still works.`,
		};
	}

	/**
	 * Whether an auto (episodic) write may target `bank`. Convenience over
	 * {@link decideAutoRetain} when the reason is not needed.
	 */
	async canAutoRetain(bank: string): Promise<boolean> {
		return (await this.decideAutoRetain(bank)).allowed;
	}

	/** The resolved policy for `bank`, or `undefined` if no entity binds it. */
	async policy(bank: string): Promise<BankPolicy | undefined> {
		await this.#ensureLoaded();
		return this.#byBank.get(bank);
	}

	/** Every known bank policy. */
	async all(): Promise<BankPolicy[]> {
		await this.#ensureLoaded();
		return [...this.#byBank.values()];
	}

	/** Record load errors surfaced by the registry scan (empty when clean). */
	async loadErrors(): Promise<EntityLoadError[]> {
		await this.#ensureLoaded();
		return [...this.#loadErrors];
	}
}
