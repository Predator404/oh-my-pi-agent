---
name: followup
description: Capture an OMA follow-up item from the `@@Phi: follow-up - <text>` trigger — append it to the vault follow-up register under the active change section, then commit and push the vault. Use when `@@Phi: follow-up -` appears in a message.
license: MIT
---

# Follow-up Capture

Trigger: `@@Phi: follow-up - <text>`. Everything after the hyphen is the
follow-up body. Append it to the OMA follow-up register and push the vault.

## Location

- Register: `~/Work/git/oma-vault/projects/oh-my-pi-agents/follow-ups.md`
- Vault repo: `Predator404/oma-vault.git`, branch `main`.

## Format

Each follow-up is a `- [ ]` checklist item under the most recent change section.
If no section exists for the current change, create one:

```markdown
## <change title> — <commit prefix>

- [ ] <captured follow-up text>
```

Items are open (`[ ]`) by default. When resolved, mark `[x]`.

## Workflow

### 1. Extract the follow-up text

Parse the trigger: `@@Phi: follow-up - <text>`. Capture `<text>` verbatim
(trim leading/trailing whitespace only).

### 2. Identify the active change

Read the vault changelog (`Changelog.md`) to find the most recent dated entry.
Use its title as the section heading for the follow-up register.

If the active change has no section in `follow-ups.md` yet, create one matching
the changelog entry title.

### 3. Append the item

Insert a new `- [ ] <text>` line under the active change section. If the
section already has items, append after the last one.

### 4. Commit and push the vault

```bash
cd ~/Work/git/oma-vault
git add projects/oh-my-pi-agents/follow-ups.md
git commit -m "follow-up: <brief summary of captured item>"
git push origin main
```

- Stage ONLY the follow-ups file. Leave `.obsidian/` churn unstaged.
- Brief commit message summarizing the captured item.

## Gotchas

- **NEVER overwrite existing items.** Append only; existing `[x]` and `[ ]`
  items are immutable history.
- **One item per trigger.** Multiple follow-ups → multiple `@@Phi: follow-up -`
  messages.
- **Link deep threads.** If a follow-up needs more than a paragraph, create a
  note under `investigations/` and link it from the item instead of restating.
- **Vault push is independent.** Failure to push the vault does not block the
  conversation; surface the error and retry.
