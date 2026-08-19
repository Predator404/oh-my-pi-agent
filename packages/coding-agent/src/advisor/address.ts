/**
 * Direct advisor addressing (`@@<name>: <message>`).
 *
 * A user can direct a message at a specific advisor by prefixing it with a
 * double-`@` sigil and the advisor's name, e.g. `@@Phi: is the daemon up?`.
 * The double sigil deliberately avoids OMP's single-`@` file/import namespace
 * (`@path`, `@~/vault/...`). When a live advisor matches the addressed name the
 * session defers the primary turn to it ({@link primaryDeferralInstruction})
 * and the advisor answers the question directly, overriding its usual
 * bias-to-silence ({@link advisorDirectAddressInstruction}).
 */

import { prompt } from "@oh-my-pi/pi-utils";
import directAddressTemplate from "../prompts/advisor/direct-address.md" with { type: "text" };
import primaryDeferralTemplate from "../prompts/advisor/primary-deferral.md" with { type: "text" };

/** A parsed `@@<name>: <message>` advisor address. */
export interface AdvisorAddress {
	/** The addressed token exactly as typed; resolve it against the live roster. */
	name: string;
	/** The message body after the `@@<name>:` prefix, trimmed. */
	question: string;
}

/**
 * Leading `@@<name>:` only. `<name>` starts with a letter and allows
 * word/`.`/`-`/`_` characters (the roster's slug alphabet). Everything after
 * the first colon is the addressed message.
 */
const ADVISOR_ADDRESS_PATTERN = /^\s*@@([A-Za-z][A-Za-z0-9._-]*)\s*:\s*([\s\S]*)$/;

/**
 * Parse a leading `@@<name>: <message>` address. Returns `undefined` when the
 * text is not an address or carries no message body after the prefix.
 */
export function parseAdvisorAddress(text: string): AdvisorAddress | undefined {
	const match = ADVISOR_ADDRESS_PATTERN.exec(text);
	if (!match) return undefined;
	const question = match[2].trim();
	if (question.length === 0) return undefined;
	return { name: match[1], question };
}

/**
 * The standing capability appended to every advisor's system prompt so a direct
 * `@@<name>:` address is answered rather than treated as ambient context.
 * Templated with the advisor's own name to keep the feature general (any
 * advisor is addressable), not tied to one persona.
 */
export function advisorDirectAddressInstruction(advisorName: string): string {
	return prompt.render(directAddressTemplate, { advisorName }).trim();
}

/**
 * The per-turn directive appended to the PRIMARY agent's system prompt when a
 * message is addressed to a live advisor: the primary defers so the advisor
 * owns the answer.
 */
export function primaryDeferralInstruction(advisorName: string): string {
	return prompt.render(primaryDeferralTemplate, { advisorName }).trim();
}
