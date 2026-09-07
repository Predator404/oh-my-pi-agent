---
name: omaChangelogUpdate
description: Update the OMA project changelog in the phi oma-vault — record OMA's own agent work in its own dated oma-agent-versioned entry, keep upstream-rebase pull-ins in separate quote blocks, determine the omp base from the fork's rebase target, bump the oma-agent SemVer, and commit+push the vault alone. Use when asked to update the OMA changelog, note OMA work or an upstream rebase, bump oma-agent, or record an OMA change in the vault.
license: MIT
---

# OMA Changelog Update

**Core rule: OMA's own work and upstream rebases are never one entry.**

## Location

`~/oma-registry/vault/projects/oh-my-pi-agents/confluence/Changelog.md` — commit/push vault only (`Predator404/oma-vault.git`, branch `main`). NEVER commit to `oh-my-pi-agent`. `packages/coding-agent/CHANGELOG.md` is the OMP/upstream changelog — do not conflate.

## Version tracks

- **`omp`** — upstream-synced; moves only on upstream rebase.
- **`oma-agent`** — SemVer for OMA's own work. Feature → minor, fix → patch.

Every entry tagged: `oma-agent X.Y.Z · on omp A.B.C`.

## Legend

🚀 feature · 🐞 fix · 🔧 internal  
Upstream rebases: `> ### 🔄 UPSTREAM REBASE — omp X → omp Y (date)` block quote with OMP release links.

## Workflow

1. Read changelog — find current `omp` base and `oma-agent` version.
2. `omp` base: latest released `## [X]` in `packages/coding-agent/CHANGELOG.md` = what `upstream/main` sits on.
3. Classify: OMA's own work → `oma-agent` dated entry; upstream pull → rebase block quote.
4. Bump `oma-agent`: feature → minor, fix → patch. No new OMA work → no bump.
5. Write:
   - `## [Unreleased]` = `_Nothing pending._`
   - `## YYYY-MM-DD — oma-agent X.Y.Z · on omp A.B.C` with 🚀/🐞/🔧 bullets
   - Separate `> ### 🔄 UPSTREAM REBASE` block if rebase occurred
6. Update two-version-track header and frontmatter `updated:`.

## Commit

```sh
cd ~/oma-registry/vault
git add projects/oh-my-pi-agents/confluence/Changelog.md
git commit -m "changelog: oma-agent X.Y.Z — <brief>"
git push origin main
```

Stage ONLY the changelog (and intentional vault docs) — leave `.obsidian/` churn unstaged.

## Rules

- NEVER rewrite released dated entries — append/newest-first only.
- Rebase may leave `packages/coding-agent/CHANGELOG.md` with duplicated sections — reconcile in a separate repo task, not here.
- Change is not done until changelog AND `follow-ups.md` are both updated (ADR 0003).
