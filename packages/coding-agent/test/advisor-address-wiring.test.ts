import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Verifies the direct-address capability (`@@<name>:`) is wired into a real
// advisor's system prompt through the live session build — the deterministic
// half of the `@@name:` feature (the advisor answering is model-driven and
// exercised interactively).
describe("advisor direct-address wiring", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			await tempDir.remove();
		}
	});

	it("injects the @@<name>: capability into a named advisor's system prompt", async () => {
		const tempDir = TempDir.createSync("@pi-advisor-address-");
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project-root");
		fs.mkdirSync(cwd, { recursive: true });
		// A named advisor roster so the capability templates a real name.
		fs.writeFileSync(
			path.join(cwd, "WATCHDOG.yml"),
			"advisors:\n  - name: Phi\n    enabled: true\n    instructions: |\n      You are Phi.\n",
			"utf8",
		);

		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		try {
			authStorage.setRuntimeApiKey("openai", "test-key");
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const sessionManager = SessionManager.inMemory(cwd);
			const result = await createAgentSession({
				cwd,
				agentDir: tempDir.path(),
				sessionManager,
				authStorage,
				modelRegistry,
				settings: (() => {
					const s = Settings.isolated({
						"async.enabled": false,
						"advisor.enabled": true,
					});
					s.setModelRole("advisor", "openai/gpt-4o-mini");
					return s;
				})(),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				workspaceTree: {
					rootPath: cwd,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			session = result.session;

			expect(session.isAdvisorActive()).toBe(true);
			const dump = session.formatAdvisorHistoryAsText();
			expect(dump).not.toBeNull();
			// The standing capability, templated with the advisor's own name.
			expect(dump).toContain("Direct address");
			expect(dump).toContain("@@Phi:");
		} finally {
			try {
				await session?.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
});
