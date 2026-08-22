/**
 * Post-auto-compaction bridge: re-inject a live-state manifest of the persistent
 * Python kernel into the model's context.
 *
 * Compaction rewrites the transcript the model reads but does NOT reset the
 * `eval` py-kernel (its lifetime is bound to the owning {@link AgentSession}, not
 * the context window). So after a successful compaction the model can forget the
 * variables/imports it deliberately stashed while the kernel still holds them —
 * the "compaction trap". This module closes the awareness gap: on a successful
 * `auto_compaction_end`, if a live kernel exists for the session, introspect its
 * `user_ns` and inject a compact manifest as a developer context message.
 *
 * Runs for every SDK-created session (interactive AND resident/headless entity
 * workers) because it is wired in `createAgentSession` — see `sdk.ts`.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AutoCompactionEndEvent } from "../../extensibility/shared-events";
import { hasKernelSessionForOwner } from "./executor";
import { buildStateManifest, type ManifestKernel } from "./state-manifest";
import framing from "./state-manifest-preamble.md" with { type: "text" };

/** Minimal surface {@link handleAutoCompactionEndManifest} needs from a session. */
export interface ManifestInjectionSession {
	getEvalKernelOwnerId(): string;
	executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<{ output: string }>;
	agent: {
		appendMessage(message: { role: "developer"; content: string; attribution: "agent"; timestamp: number }): void;
	};
}

/** Overridable collaborators (test seam); production defaults query the real kernel registry. */
export interface ManifestInjectionDeps {
	/** Non-spawning check for a live kernel owned by this session. */
	hasLiveKernel?: (ownerId: string) => boolean;
}

/** True only for a fully successful compaction worth re-injecting state for. */
function isSuccessfulCompaction(event: AutoCompactionEndEvent): boolean {
	return Boolean(event.result) && !event.aborted && !event.willRetry && !event.skipped;
}

/**
 * On a successful compaction, introspect the session's live Python kernel and
 * inject a state manifest as a developer message. No-op (and never throws) when
 * the gate fails, no live kernel exists, or the kernel holds no user state.
 */
export async function handleAutoCompactionEndManifest(
	session: ManifestInjectionSession,
	event: AutoCompactionEndEvent,
	deps?: ManifestInjectionDeps,
): Promise<void> {
	if (!isSuccessfulCompaction(event)) return;
	const hasLiveKernel = deps?.hasLiveKernel ?? hasKernelSessionForOwner;
	try {
		const ownerId = session.getEvalKernelOwnerId();
		// Existence gate: never spawn a kernel just to introspect. If nothing is
		// live for this owner there is no stashed state to lose to compaction.
		if (!hasLiveKernel(ownerId)) return;
		const kernel: ManifestKernel = {
			// `excludeFromContext` keeps the introspection cell out of the
			// transcript, so it cannot itself trigger recursion/compaction.
			execute: async code => ({
				output: (await session.executePython(code, undefined, { excludeFromContext: true })).output,
			}),
		};
		const manifest = await buildStateManifest(kernel);
		if (manifest.length === 0) return;
		session.agent.appendMessage({
			role: "developer",
			content: framing + manifest,
			attribution: "agent",
			timestamp: Date.now(),
		});
	} catch (error) {
		// Never throw into the compaction handler — a failed introspection must
		// degrade to "no manifest", not break the compaction lifecycle.
		logger.warn("Post-compaction state manifest injection failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
