import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-tui/prompt/prompt-action-autocomplete";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createEntityMentionSource, invalidateEntityMentionCache } from "../src/modes/entity-mention-source";

describe("createEntityMentionSource + @@ entity picker", () => {
	const originalRegistry = process.env.OMP_ENTITY_REGISTRY;
	let registryDir: TempDir;
	let projectDir: TempDir;

	beforeEach(async () => {
		registryDir = TempDir.createSync("@pi-pa-entity-");
		projectDir = TempDir.createSync("@pi-pa-project-");
		const entitiesDir = `${registryDir.path()}/entities`;
		await Bun.write(
			`${entitiesDir}/phi.md`,
			"---\nname: phi\ndescription: Reviewer persona.\nrole: persona\nmemory:\n  backend: mnemopi\n  bank: phi\nvaultSection: personas/phi\n---\nYou are Phi.\n",
		);
		await Bun.write(`${projectDir.path()}/README.md`, "# readme\n");
		process.env.OMP_ENTITY_REGISTRY = registryDir.path();
		invalidateEntityMentionCache();
	});

	afterEach(async () => {
		if (originalRegistry === undefined) delete process.env.OMP_ENTITY_REGISTRY;
		else process.env.OMP_ENTITY_REGISTRY = originalRegistry;
		invalidateEntityMentionCache();
		await registryDir.remove();
		await projectDir.remove();
	});

	function provider() {
		return createPromptActionAutocompleteProvider({
			commands: [],
			basePath: projectDir.path(),
			entityMentions: createEntityMentionSource(),
			keybindings: KeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});
	}

	it("`@@` opens the entity picker and inserts a @@<name>: address", async () => {
		const p = provider();
		const suggestions = await p.getSuggestions(["@@ph"], 0, 4);
		expect(suggestions?.prefix).toBe("@@ph");
		expect(suggestions?.items.map(i => i.value)).toEqual(["@@phi: "]);

		const applied = p.applyCompletion(["@@ph"], 0, 4, suggestions!.items[0]!, "@@ph");
		expect(applied.lines).toEqual(["@@phi: "]);
	});

	it("`@@@` escapes back to the file picker with a single-@ value", async () => {
		const p = provider();
		const suggestions = await p.getSuggestions(["@@@READ"], 0, 7);
		expect(suggestions?.prefix).toBe("@@@READ");
		const readme = suggestions?.items.find(i => i.value.includes("README.md"));
		expect(readme?.value).toBe("@README.md");

		const applied = p.applyCompletion(["@@@READ"], 0, 7, readme!, "@@@READ");
		expect(applied.lines).toEqual(["@README.md"]);
	});

	it("a single `@` still lists files, not entities", async () => {
		const suggestions = await provider().getSuggestions(["@READ"], 0, 5);
		expect(suggestions?.items.some(i => i.value === "@README.md")).toBe(true);
		expect(suggestions?.items.some(i => i.value === "@@phi: ")).toBe(false);
	});

	it("does not open the entity picker mid-message", async () => {
		// `@@` past the start of the message is not an address; the picker must
		// not offer entities there (matches parseAdvisorAddress's leading anchor).
		const suggestions = await provider().getSuggestions(["ask @@ph"], 0, 8);
		expect(suggestions?.items.some(i => i.value === "@@phi: ")).not.toBe(true);
	});
});
