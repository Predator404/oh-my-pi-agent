/**
 * OMA entity-registry candidate source for the `@@`-mention picker
 * (`@oh-my-pi/pi-tui/prompt/entity-autocomplete`). Bridges the generic,
 * host-agnostic picker mechanics in pi-tui to the OMA entity registry.
 */
import type { EntityMentionCandidate, EntityMentionCandidateSource } from "@oh-my-pi/pi-tui/prompt/entity-autocomplete";
import { discoverEntities } from "../entity";

const ENTITY_CACHE_TTL_MS = 5_000;

/** Registry scans hit disk; a short TTL keeps per-keystroke lookups allocation-cheap. */
let entityCache: { at: number; entities: EntityMentionCandidate[] } | undefined;

/** Drop the cached entity roster so the next lookup re-scans the registry. */
export function invalidateEntityMentionCache(): void {
	entityCache = undefined;
}

/** Create a candidate source backed by the on-disk OMA entity registry. */
export function createEntityMentionSource(): EntityMentionCandidateSource {
	return async () => {
		const now = Date.now();
		if (entityCache && now - entityCache.at < ENTITY_CACHE_TTL_MS) return entityCache.entities;
		try {
			const { entities } = await discoverEntities();
			const mapped = entities.map(entity => ({
				name: entity.name,
				description: entity.description,
				role: entity.role,
				icon: entity.icon,
			}));
			entityCache = { at: now, entities: mapped };
			return mapped;
		} catch {
			// No registry (or an unreadable one) means no entities to offer; cache the
			// empty result so a missing registry does not re-scan on every keystroke.
			entityCache = { at: now, entities: [] };
			return [];
		}
	};
}
