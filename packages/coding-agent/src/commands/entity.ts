/**
 * `omp entity` — operate the persistent multi-entity runtime (SPEC §12.7).
 *
 * Registry/config: roster, show, create, config. Runtime (C4): spawn, ps,
 * attach, detach, stop, prompt, steer, follow-up, send, schedule, heartbeat,
 * goal, autonomous. Bootstrap (WS7a): setup. Business logic lives in
 * `../cli/entity-cli` so dispatch is unit-testable without a live broker.
 */
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { entityHelp as commandHelp } from "../cli/command-help";
import { defaultEntityDeps, type EntityCommand, EntityCommandUsageError, runEntityCommand } from "../cli/entity-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS = [
	"roster",
	"list",
	"show",
	"create",
	"config",
	"setup",
	"spawn",
	"ps",
	"sessions",
	"attach",
	"detach",
	"stop",
	"prompt",
	"steer",
	"follow-up",
	"send",
	"schedule",
	"heartbeat",
	"goal",
	"autonomous",
	"transcript",
	"logs",
	"daemon",
] as const;

export default class Entity extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({ description: "Entity action", required: false, options: ACTIONS }),
		targets: Args.string({ description: "Action arguments (name / id / text)", required: false, multiple: true }),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		cwd: Flags.string({ description: "Working directory for a spawned entity session" }),
		registry: Flags.string({ description: "Entity-registry root override" }),
		force: Flags.boolean({
			char: "f",
			description: "Overwrite / relink on conflict; relocate a live entity on spawn",
		}),
		wait: Flags.boolean({ description: "prompt: block for the entity's reply and print it" }),
		last: Flags.integer({ description: "transcript: number of recent turns to dump (default 10)" }),
		mode: Flags.string({
			description: "send delivery: auto|steer|follow_up",
			options: ["auto", "steer", "follow_up"],
		}),
		delivery: Flags.string({ description: "scheduled delivery: steer|follow_up", options: ["steer", "follow_up"] }),
		label: Flags.string({ description: "Label for a scheduled job" }),
		"include-inactive": Flags.boolean({ description: "schedule list: include completed/cancelled jobs" }),
		budget: Flags.integer({ description: "goal set: token budget" }),
		"max-continuations": Flags.integer({ description: "autonomous on: max continuations" }),
		"max-turns": Flags.integer({ description: "autonomous on: max turns" }),
		"max-tokens": Flags.integer({ description: "autonomous on: max tokens" }),
		timeout: Flags.integer({ description: "autonomous on: wall-clock timeout (seconds)" }),
		role: Flags.string({ description: "create: agent|persona", options: ["agent", "persona"] }),
		description: Flags.string({ description: "create: one-line description" }),
		model: Flags.string({ description: "create: model selector(s), comma-separated" }),
		thinking: Flags.string({ description: "create: thinking/effort level" }),
		tools: Flags.string({ description: "create: tool grant list, comma-separated" }),
		skills: Flags.string({ description: "create: autoload skills, comma-separated" }),
		bank: Flags.string({ description: "create: memory bank name (default: entity name)" }),
		"auto-retain": Flags.boolean({ description: "create: enable episodic auto-retain (agent role only)" }),
		"vault-section": Flags.string({ description: "create: owned vault subtree" }),
		endpoint: Flags.string({ description: "create: hosting model-endpoint provider id" }),
		prompt: Flags.string({ description: "create: system-prompt body (else read stdin)" }),
		icon: Flags.string({ description: "create: single display glyph (emoji/char)" }),
		color: Flags.string({ description: "create: theme-color token (accent, success, ...)" }),
		set: Flags.string({ description: "config: key=value update (repeatable)", multiple: true }),
		vault: Flags.string({ description: "setup: actual vault location for the ~/vault symlink" }),
		"registry-source": Flags.string({ description: "setup: repo-2 registry checkout to wire the root to" }),
		"no-endpoints": Flags.boolean({ description: "setup: skip local model-endpoint registration" }),
		"warm-cache": Flags.boolean({
			description: "setup: prefetch the vault embedder (one network step; offline after)",
		}),
	};

	static examples = [
		"# Scaffold a new persona (prompt piped on stdin)\n  echo 'You are ...' | omp entity create sage --role persona --description 'Domain expert'",
		"# Edit config without hand-editing YAML\n  omp entity config sage --set model=anthropic/opus --set thinking=high",
		"# See the roster and running sessions\n  omp entity roster\n  omp entity ps",
		"# Spawn, schedule a heartbeat, set a durable goal\n  omp entity spawn sage\n  omp entity heartbeat set <id> 'every 30m' 'Review the queue'\n  omp entity goal set <id> 'Triage open issues' --budget 200000",
		"# One-time idempotent bootstrap\n  omp entity setup --registry-source ~/persistentAgents/registry",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Entity);
		if (!args.action) {
			renderCommandHelp("omp", "entity", Entity);
			return;
		}

		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];
		const cmd: EntityCommand = {
			action: args.action,
			args: targets,
			flags: {
				json: flags.json,
				cwd: flags.cwd,
				registry: flags.registry,
				force: flags.force,
				wait: flags.wait,
				last: flags.last,
				mode: flags.mode,
				delivery: flags.delivery,
				label: flags.label,
				includeInactive: flags["include-inactive"],
				budget: flags.budget,
				maxContinuations: flags["max-continuations"],
				maxTurns: flags["max-turns"],
				maxTokens: flags["max-tokens"],
				timeout: flags.timeout,
				role: flags.role,
				description: flags.description,
				model: flags.model,
				thinking: flags.thinking,
				tools: flags.tools,
				skills: flags.skills,
				bank: flags.bank,
				autoRetain: flags["auto-retain"],
				vaultSection: flags["vault-section"],
				endpoint: flags.endpoint,
				prompt: flags.prompt,
				icon: flags.icon,
				color: flags.color,
				set: flags.set,
				vault: flags.vault,
				registrySource: flags["registry-source"],
				noEndpoints: flags["no-endpoints"],
				warmCache: flags["warm-cache"],
			},
		};

		await initTheme();
		try {
			await runEntityCommand(cmd, await defaultEntityDeps());
		} catch (error) {
			if (error instanceof EntityCommandUsageError) {
				process.stderr.write(`error: ${error.message}\n`);
				process.exitCode = 1;
				return;
			}
			throw error;
		}
	}
}
