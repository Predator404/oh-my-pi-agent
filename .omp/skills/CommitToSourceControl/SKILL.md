---
name: CommitToSourceControl
description: End-to-end OMA release workflow — classify pending changes, bump the oma-agent SemVer (patch for bugs, minor for small changes/features, major for big/breaking changes), build the binary, update the vault changelog, commit both repos, and optionally open + merge a PR. Use when asked to commit, release, ship, or cut a new OMA version.
license: MIT
---

# Commit to Source Control

Full OMA release pipeline: inventory → classify → bump → build → changelog →
commit → push → PR (optional). Every step gates the next; a failure MUST be
resolved before continuing.

## Repos

| Repo | Remote | Branch | Holds |
|---|---|---|---|
| `oh-my-pi-agent` | `origin` (Predator404/oh-my-pi-agent) | `oma` | Source, binary, `OMA_VERSION` |
| `oma-vault` | `origin` (Predator404/oma-vault) | `main` | Changelog, follow-ups, docs |

## Version Bump Rules

Read current `OMA_VERSION` from `packages/coding-agent/src/oma-identity.ts`.
Classify every pending change (git diff against `origin/oma`), then bump
**exactly one segment** — the highest classification wins:

| Classification | Bump | Examples |
|---|---|---|
| **Patch** (`Z`) | Bug fixes, typo corrections, visual glitches, minor cleanup, display fixes | `0.9.0` → `0.9.1` |
| **Minor** (`Y`) | New features, small enhancements, non-breaking additions, new skills, logo/skin changes | `0.9.0` → `0.10.0` |
| **Major** (`X`) | Breaking API changes, architecture rewrites, daemon protocol bumps, vault schema changes | `0.9.0` → `1.0.0` |

- **Tie-breaking**: feature + bug in one batch → minor (feature dominates).
- **No net change**: leave version alone; skip the bump step.
- NEVER bump more than one segment per release.
- NEVER bump the `omp` base version — that moves ONLY on an upstream rebase
  (delegates to `omaChangelogUpdate` skill).

## Workflow

### 1. Inventory changes

```bash
git diff origin/oma --stat
git diff origin/oma
```

List every changed file. Classify each as bug, feature, or internal. State the
classification explicitly before touching any file.

### 2. Compute new version

Apply the bump rules above. State the current version, the classification, and
the new version. Example: `0.9.0 + bug fix → patch → 0.9.1`.

### 3. Build the binary

```bash
cd packages/coding-agent && bun run build
```

- MUST exit 0. Failure → fix; NEVER proceed with a broken build.
- Binary lands at `packages/coding-agent/dist/omp`.

### 4. Update the vault changelog

Delegate to the `omaChangelogUpdate` skill procedure:

- Read `~/Work/git/oma-vault/projects/oh-my-pi-agents/confluence/Changelog.md`.
- Update frontmatter `updated:` and two-version-track header.
- Add a new dated entry `## YYYY-MM-DD — oma-agent X.Y.Z · on omp A.B.C`
  with a 🚀/🐞/🔧 bullet per change.
- Keep `[Unreleased]` as `_Nothing pending._`.

### 5. Bump OMA_VERSION

```typescript
// packages/coding-agent/src/oma-identity.ts
export const OMA_VERSION = "X.Y.Z"; // ← new version
```

### 6. Commit the source repo

```bash
git add <changed files>
git commit -m "feat(oma): <brief>" -m "<bullet list>"
git push origin oma
```

- Conventional commit prefix: `feat(oma):`, `fix(oma):`, `chore(oma):`.
- MUST push `oma` branch, NEVER `main`/`master`.
- Run `bun check` before committing if TypeScript changed.

### 7. Commit the vault

```bash
cd ~/Work/git/oma-vault
git add projects/oh-my-pi-agents/confluence/Changelog.md
git commit -m "changelog: oma-agent X.Y.Z — <brief>"
git push origin main
```

- Stage ONLY the changelog. Leave `.obsidian/` churn unstaged.

### 8. PR gate (optional)

When review is required before merge:

```bash
gh pr create \
  --repo Predator404/oh-my-pi-agent \
  --base oma --head oma \
  --title "feat(oma): <brief>" \
  --body "<change summary>"
```

- Wait for approval: `gh pr view --json state,reviewDecision`.
- On approval: `gh pr merge --squash --delete-branch`.
- Skip this step for direct-push workflow.

### 9. Verify

```bash
cd packages/coding-agent && dist/omp --version   # must show oma/X.Y.Z
git -C ~/Work/git/oma-vault log -1 --oneline     # vault commit live
```

## Gotchas

- **NEVER commit unrelated generated files.** Build may regenerate
  `browser-relay` assets or `collab-web` bundles identically; check
  `git status` before staging.
- **NEVER bump the omp base version.** It moves only on upstream rebase.
- **Two repos, two commits.** Both MUST succeed; handle failures independently.
- **Changelog is immutable history.** Append only; NEVER edit released entries
  unless explicitly renumbering under this skill's version rules.
- **`bun check` before commit** when TypeScript changed. Broken mainline after
  commit is a regression.
