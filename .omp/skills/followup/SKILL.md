---
name: followup
description: Capture an OMA follow-up item from the `@@Phi: follow-up - <text>` trigger — append it to the vault follow-up register under a topic-based section, then commit and push the vault. Use when `@@Phi: follow-up -` appears in a message.
license: MIT
---

# Follow-up Capture

Trigger: `@@Phi: follow-up - <text>`. Capture everything after the hyphen verbatim (trim whitespace only). Append to vault register under a topic section; push vault.

Follow-ups are open tasks — NOT tied to a version. Group by topic, not release.

## Location

`~/oma-registry/vault/projects/oh-my-pi-agents/follow-ups.md` — `Predator404/oma-vault.git`, branch `main`.

## Format

```markdown
## <Topic>

- [ ] <text>
```

`[ ]` by default; `[x]` when resolved.

## Workflow

### 1. Extract

Parse trigger; capture `<text>` verbatim.

### 2. Topic

Infer from content:

| Content | Topic |
|---|---|
| Prompts, addressing, UX | `Agent UX` |
| Daemon, workers, broker | `Daemon / workers` |
| Vault, memory, notes | `Vault & memory` |
| CLI, commands, flags | `CLI` |
| TUI, rendering, colors | `TUI` |
| Skills, tools, MCP | `Skills & tools` |
| Build, compile, release | `Build & release` |

No match → new `## <topic>` heading.

### 3. Append

Insert `- [ ] <text>` under the topic section, after the last existing item.

### 4. Commit and push

```sh
cd ~/oma-registry/vault
git add projects/oh-my-pi-agents/follow-ups.md
git commit -m "follow-up: <topic> — <brief>"
git push origin main
```

Stage ONLY follow-ups.md — leave `.obsidian/` churn unstaged.

## Rules

- NEVER tie follow-ups to versions.
- NEVER overwrite existing items — append only; `[ ]`/`[x]` are immutable history.
- One item per trigger; multiple follow-ups → multiple `@@Phi: follow-up -` messages.
- Deep thread → note under `investigations/`; link from item.
- Vault push failure doesn't block conversation; surface error and retry.
