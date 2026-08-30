---
name: omaChangelogUpdate
description: Update the OMA project changelog in the phi oma-vault — record OMA's own agent work in its own dated oma-agent-versioned entry, keep upstream-rebase pull-ins in separate quote blocks, determine the omp base from the fork's rebase target, bump the oma-agent SemVer, and commit+push the vault alone. Use when asked to update the OMA changelog, note OMA work or an upstream rebase, bump oma-agent, or record an OMA change in the vault.
license: MIT
---

# OMA changelog update

End-to-end flow for recording work in the phi OMA changelog. The central,
recurring rule that keeps it sane: **OMA's own work and upstream rebases are
never lumped into one entry.**

## Location & repo

- Changelog: `~/Work/git/oma-vault/projects/oh-my-pi-agents/confluence/Changelog.md`
- Vault repo: `Predator404/oma-vault.git`, branch `main`.
- Commit and push **there**, never in the `oh-my-pi-agent` repo. The repo's
  `packages/coding-agent/CHANGELOG.md` is the OMP/upstream changelog — do NOT
  conflate the two.

## Mental model — two independent version tracks

- **`omp`** — upstream-synced. Moves **only on an upstream rebase**; it is the
  OMP release OMA sits on. Pure OMP-core fixes contributed back upstream ride
  the OMP changelog, not this one.
- **`oma-agent`** — SemVer keyed to OMA's own agent work. Feature → minor bump,
  fix → patch bump. Headline number describing the persistent-agent build.

Every entry is tagged `oma-agent X.Y.Z · on omp A.B.C`.

## Legend

- 🚀 feature · 🐞 fix · 🔧 internal/process
- Upstream rebases are `> ### 🔄 UPSTREAM REBASE — omp X → omp Y (date)` block
  quotes with links to the OMP release notes / diff / changelog.

## Core rule

- Each OMA change gets its **own dated entry**:
  `## YYYY-MM-DD — oma-agent X.Y.Z · on omp A.B.C`.
- An upstream rebase gets a **separate block quote**. It describes only the
  pulled-in OMP range + links. It may point to the OMA entry that carries the
  OMA-side reconciliation, but never narrates OMA features itself.

## Workflow

1. Read the current changelog to learn the recorded `omp` base and `oma-agent`
   version (header + newest dated entry).
2. Determine the `omp` base from the fork's rebase target: the OH-MY-PI
   `packages/coding-agent/CHANGELOG.md` latest released `## [X]` is the OMP
   release current `upstream/main` sits on. A rebase moves the recorded base to
   that release.
3. Classify each item: OMA's own work (→ its own `oma-agent` entry) vs an
   upstream pull (→ a rebase block).
4. Compute the `oma-agent` bump over the current version: feature → minor, fix
   → patch. No new agent work? leave the number alone.
5. Write the changelog:
   - `## [Unreleased]` = `_Nothing pending._` (or only genuinely pending items).
   - A dated entry for the OMA work, tagged `oma-agent X.Y.Z · on omp A.B.C`.
   - A separate `> ### 🔄 UPSTREAM REBASE` block if a rebase happened.
6. Keep `[Unreleased]` empty once the work is versioned under its dated entry.
7. Update the two-version-track header (`Current: omp A.B.C` / `oma-agent
   X.Y.Z`) and the frontmatter `updated:` date.

## Gotchas

- **Stage/push only the changelog** (and any vault docs you intentionally
  changed). Leave `.obsidian/` app churn (`community-plugins.json`,
  `core-plugins.json`, plugin `data.json`) unstaged.
- Never rewrite already-released dated entries — append / add newest-first only;
  released history is immutable.
- A rebase can leave the repo CHANGELOG with duplicated released sections; that
  reconciliation is a **separate repo task**, not part of this vault flow.
- The follow-up register
  (`projects/oh-my-pi-agents/follow-ups.md`) is the binding parallel to the
  changelog: OMA feature/bug work also gets its open follow-ups recorded there
  (ADR 0003). A change isn't done until both are updated.
