import { describe, expect, it } from "bun:test";
import {
	applyEntityMentionCompletion,
	collapseMentionToSingleAt,
	type EntityMentionCandidate,
	extractEntityMention,
	getEntityMentionSuggestions,
	isEntityMentionPrefix,
} from "@oh-my-pi/pi-tui/prompt/entity-autocomplete";

describe("extractEntityMention", () => {
	it("counts the leading @-run and splits off the query", () => {
		expect(extractEntityMention("@")).toEqual({ token: "@", atCount: 1, query: "" });
		expect(extractEntityMention("@@")).toEqual({ token: "@@", atCount: 2, query: "" });
		expect(extractEntityMention("@@ph")).toEqual({ token: "@@ph", atCount: 2, query: "ph" });
		expect(extractEntityMention("@@@src/f")).toEqual({ token: "@@@src/f", atCount: 3, query: "src/f" });
	});

	it("anchors the token to line start or whitespace", () => {
		expect(extractEntityMention("say @@ph")).toEqual({ token: "@@ph", atCount: 2, query: "ph" });
		// A run glued to a preceding non-space char is an email-ish literal, not a mention.
		expect(extractEntityMention("foo@@ph")).toBeNull();
		expect(extractEntityMention("")).toBeNull();
		// A closed token (trailing space) is no longer the token at the cursor.
		expect(extractEntityMention("@@phi: ")).toBeNull();
	});
});

describe("isEntityMentionPrefix", () => {
	it("is true only for @@+ tokens", () => {
		expect(isEntityMentionPrefix("@@ph")).toBe(true);
		expect(isEntityMentionPrefix("@@@src")).toBe(true);
		expect(isEntityMentionPrefix("@ph")).toBe(false);
		expect(isEntityMentionPrefix("#copy")).toBe(false);
	});
});

describe("applyEntityMentionCompletion", () => {
	it("replaces the live @@-run with the entity address value", () => {
		const result = applyEntityMentionCompletion(["@@ph"], 0, 4, { value: "@@phi: ", label: "phi" }, "@@ph");
		expect(result.lines).toEqual(["@@phi: "]);
		expect(result.cursorCol).toBe("@@phi: ".length);
	});

	it("preserves surrounding text when replacing mid-line", () => {
		const line = "hey @@ph";
		const result = applyEntityMentionCompletion([line], 0, line.length, { value: "@@phi: ", label: "phi" }, "@@ph");
		expect(result.lines).toEqual(["hey @@phi: "]);
		expect(result.cursorCol).toBe("hey @@phi: ".length);
	});
});

describe("collapseMentionToSingleAt", () => {
	it("drops all but one @ so the base file picker sees a single-@ mention", () => {
		const mention = { token: "@@@src", atCount: 3, query: "src" };
		const result = collapseMentionToSingleAt(["@@@src"], 0, 6, mention);
		expect(result.lines).toEqual(["@src"]);
		expect(result.cursorCol).toBe(4);
	});

	it("only collapses the token, leaving earlier text intact", () => {
		const mention = { token: "@@@src", atCount: 3, query: "src" };
		const result = collapseMentionToSingleAt(["go @@@src"], 0, 9, mention);
		expect(result.lines).toEqual(["go @src"]);
		expect(result.cursorCol).toBe(7);
	});
});

describe("getEntityMentionSuggestions", () => {
	const candidates: EntityMentionCandidate[] = [
		{ name: "phi", description: "Careful reviewer persona.", role: "persona" },
		{ name: "atlas", description: "Episodic build agent.", role: "agent" },
	];

	it("fuzzy-matches supplied candidates and inserts a @@<name>: address value", async () => {
		const items = await getEntityMentionSuggestions(
			{ token: "@@ph", atCount: 2, query: "ph" },
			async () => candidates,
		);
		expect(items.map(item => item.value)).toEqual(["@@phi: "]);
		expect(items[0]?.label).toBe("phi");
		expect(items[0]?.description).toContain("persona");

		// An empty query lists every candidate.
		const all = await getEntityMentionSuggestions({ token: "@@", atCount: 2, query: "" }, async () => candidates);
		expect(all.map(item => item.label).sort()).toEqual(["atlas", "phi"]);
	});

	it("returns nothing without a candidate source", async () => {
		const items = await getEntityMentionSuggestions({ token: "@@ph", atCount: 2, query: "ph" }, undefined);
		expect(items).toEqual([]);
	});
});
