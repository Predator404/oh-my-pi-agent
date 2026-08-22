/**
 * Entity session-file location helpers (SPEC §8.1).
 *
 * A resident entity's persistent conversation lives in one JSONL session file.
 * The file's path is not stable (a fresh entity mints a UUID-named file), so
 * the durable pointer is `<agentDir>/entities/<entityName>/.session-pointer`,
 * which holds the current session file's absolute path.
 *
 * The resident worker owns writing the pointer (see `agent-worker-main.ts`);
 * these read-only helpers let the operator CLI (`entity transcript`) and the
 * `history://` resolver locate an entity's transcript on disk without a live
 * broker round-trip.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

/** Per-entity home directory: `<agentDir>/entities/<entityName>`. */
export function entityHome(entityName: string): string {
	return join(getAgentDir(), "entities", entityName);
}

/** Path of the entity's durable session pointer file. */
export function entitySessionPointerPath(entityName: string): string {
	return join(entityHome(entityName), ".session-pointer");
}

/**
 * Resolve the entity's current session JSONL path from its pointer, or
 * `undefined` when the entity has never been spawned or the pointed-at file no
 * longer exists. Never throws — a missing/corrupt pointer reads as `undefined`.
 */
export function readEntitySessionPointer(entityName: string): string | undefined {
	const pointer = entitySessionPointerPath(entityName);
	if (!existsSync(pointer)) return undefined;
	try {
		const target = readFileSync(pointer, "utf8").trim();
		if (target && existsSync(target)) return target;
	} catch {
		// Unreadable pointer — treat as no session on disk.
	}
	return undefined;
}
