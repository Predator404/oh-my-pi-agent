---
name: followup
description: Capture an OMA follow-up item from the `@@Phi: follow-up - <text>` trigger — append it to the vault follow-up register under a topic-based section, then commit and push the vault. Use when `@@Phi: follow-up -` appears in a message.
license: MIT
---

# Follow-up Capture

Trigger: `@@Phi: follow-up - <text>`. Everything after the hyphen is the
follow-up body. Append it to the OMA follow-up register under a topic section
and push the vault.

Follow-ups are open investigation/implementation tasks — they are NOT tied to a
specific oma-agent version. Group them by topic, not by release.

## Location

- Register: `~/Work/git/oma-vault/projects/oh-my-pi-agents/follow-ups.md`
- Vault repo: `Predator404/oma-vault.git`, branch `main`.

## Format

Each follow-up is a `- [ ]` checklist item under a `## <topic>` heading.
Topics group related items; create a new section when no existing topic fits.

```markdown
## Agent UX

- [ ] <captured follow-up text>
```

Items are open (`[ ]`) by default. When resolved, mark `[x]`.

## Workflow

### 1. Extract the follow-up text

Parse the trigger: `@@Phi: follow-up - <text>`. Capture `<text>` verbatim
(trim leading/trailing whitespace only).

### 2. Determine the topic

Infer a short topic name from the follow-up content. Examples:

| Follow-up about… | Topic |
|---|---|
| Agent prompts, addressing, autocomplete, UX | `Agent UX` |
| Daemon, workers, broker, spawn | `Daemon / workers` |
| Vault, memory, embeddings, notes | `Vault & memory` |
| CLI, commands, flags, output | `CLI` |
| TUI, rendering, status line, colors | `TUI` |
| Skills, tools, MCP | `Skills & tools` |
| Build, compile, release, CI | `Build & release` |

If no existing topic section fits, create a new `## <topic>` heading.

### 3. Append the item

Insert a new `- [ ] <text>` line under the topic section. If the section
already has items, append after the last one.

### 4. Commit and push the vault

```bash
cd ~/Work/git/oma-vault
git add projects/oh-my-pi-agents/follow-ups.md
git commit -m "follow-up: <topic> — <brief summary>"
git push origin main
```

- Stage ONLY the follow-ups file. Leave `.obsidian/` churn unstaged.

## Gotchas

- **NEVER tie follow-ups to oma-agent versions.** They are open tasks, not
  release notes. Use topic sections.
- **NEVER overwrite existing items.** Append only; existing `[x]` and `[ ]`
  items are immutable history.
- **One item per trigger.** Multiple follow-ups → multiple `@@Phi: follow-up -`
  messages.
- **Link deep threads.** If a follow-up needs more than a paragraph, create a
  note under `investigations/` and link it from the item.
- **Vault push is independent.** Failure to push the vault does not block the
  conversation; surface the error and retry.
