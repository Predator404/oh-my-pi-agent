---
name: commitToSourceControl
description: End-to-end OMA release workflow — classify pending changes, bump the oma-agent SemVer (patch for bugs, minor for small changes/features, major for big/breaking changes), build the binary, update the vault changelog, commit both repos, and optionally open + merge a PR. Use when asked to commit, release, ship, or cut a new OMA version.
license: MIT
---

# Commit to Source Control

Full OMA release pipeline. Each step gates the next; failures MUST be resolved before continuing.

## Repos

| Repo | Remote | Branch | Holds |
|---|---|---|---|
| `oh-my-pi-agent` | `origin` (Predator404/oh-my-pi-agent) | `oma` | Source, binary, `OMA_VERSION` |
| `oma-vault` | `origin` (Predator404/oma-vault) | `main` | Changelog, follow-ups |

## Version bump

`OMA_VERSION` in `packages/coding-agent/src/oma-identity.ts`. Classify pending changes (`git diff origin/oma`); highest class wins. NEVER bump more than one segment.

| Class | Bump | Examples |
|---|---|---|
| Bug, typo, cleanup | Patch | `0.9.1 → 0.9.2` |
| Feature, enhancement, new skill | Minor | `0.9.1 → 0.10.0` |
| Breaking API/arch/protocol | Major | `0.9.1 → 1.0.0` |

Feature + bug in one batch → minor. No net change → no bump. NEVER bump `omp` base — moves only on upstream rebase (`omaChangelogUpdate` skill).

## Workflow

### 1. Inventory

```sh
git diff origin/oma --stat && git diff origin/oma
```

List every changed file; classify as bug, feature, or internal. State classification before touching files.

### 2. Compute version

State: current · classification · new. Example: `0.9.1 + bug → patch → 0.9.2`.

### 3. Build

```sh
cd packages/coding-agent && bun run build
```

MUST exit 0; binary → `dist/omp`. Failure → fix; NEVER proceed with broken build.

### 4. Vault changelog

Delegate to `omaChangelogUpdate` skill:
- Read `~/oma-registry/vault/projects/oh-my-pi-agents/confluence/Changelog.md`
- Update frontmatter `updated:` and two-version-track header
- Add `## YYYY-MM-DD — oma-agent X.Y.Z · on omp A.B.C` with 🚀/🐞/🔧 bullets
- Keep `[Unreleased]` as `_Nothing pending._`

### 5. Bump OMA_VERSION

```ts
// packages/coding-agent/src/oma-identity.ts
export const OMA_VERSION = "X.Y.Z";
```

### 6. Commit source repo

```sh
git add <changed files>
git commit -m "feat(oma): <brief>" -m "<bullet list>"
git push origin oma
```

Prefix: `feat(oma):` / `fix(oma):` / `chore(oma):`. Push `oma` — NEVER `main`/`master`. Run `bun check` first if TypeScript changed.

### 7. Commit vault

```sh
cd ~/oma-registry/vault
git add projects/oh-my-pi-agents/confluence/Changelog.md
git commit -m "changelog: oma-agent X.Y.Z — <brief>"
git push origin main
```

Stage ONLY the changelog — leave `.obsidian/` churn unstaged.

### 8. PR (optional)

```sh
gh pr create --repo Predator404/oh-my-pi-agent --base oma --head oma \
  --title "feat(oma): <brief>" --body "<summary>"
gh pr view --json state,reviewDecision
gh pr merge --squash --delete-branch
```

Skip for direct-push workflow.

### 9. Verify

```sh
cd packages/coding-agent && dist/omp --version   # must show oma/X.Y.Z
git -C ~/oma-registry/vault log -1 --oneline
```

## Gotchas

- NEVER commit unrelated generated files (`browser-relay`, `collab-web` bundles) — check `git status` before staging.
- NEVER bump `omp` base version.
- Two repos, two commits — both MUST succeed; handle independently.
- Changelog: append only; NEVER edit released entries.
- `bun check` before commit when TypeScript changed.
