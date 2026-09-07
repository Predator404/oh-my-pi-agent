---
name: rebaseForkOnUpstream
description: Rebase a downstream fork branch onto the latest upstream main — identify remotes, find the true fork point, fold in uncommitted WIP and unpulled fork commits, replay the fork's changes onto the new base, resolve conflicts with a fork-features-win / upstream-renames-supersede policy, verify, and force-push. Use when asked to pull latest from main and rebase a fork, sync or update a downstream branch off its upstream, catch a diverged fork up to upstream, or refresh fork-only changes against upstream drift.
license: MIT
---

# Rebase fork on upstream

History rewrite — surface choices before executing. `--force-with-lease` always; never bare `--force`.

**Conflict policy:**
1. Fork feature vs upstream logic → fork feature wins, adapted to new structure
2. Upstream renamed a symbol the fork carried → adopt upstream name; drop dangling refs
3. Two distinct additions in same spot → keep both
4. Stylistic divergence → fork wins

## Phase 1 — Map

```sh
git remote -v                      # upstream = forked FROM; origin = the fork
git branch -vv
git status                         # uncommitted WIP must be handled first
git fetch upstream && git fetch origin
git merge-base DOWNSTREAM upstream/main        # true fork point
git rev-list --count DOWNSTREAM..upstream/main
git rev-list --count upstream/main..DOWNSTREAM
git log --oneline upstream/main..DOWNSTREAM
```

Fork point: `merge-base DOWNSTREAM upstream/main`, not `origin/main`. `DOWNSTREAM` behind `origin/DOWNSTREAM` → fold in unpulled commits first; they drop on rewrite otherwise.

**Confirm before proceeding:**
1. Base: `upstream/main` (default) vs stale `origin/main`
2. WIP: commit (default) or `git stash -u`
3. Unpulled fork commits: fast-forward (default: yes)
4. After rebase: force-push or hold for review

## Phase 2 — Prepare

```sh
git add -A && git commit -m "<WIP summary>"
git rebase origin/DOWNSTREAM   # seats WIP on top of unpulled commits
git log --oneline -6 DOWNSTREAM
```

`git pull --ff-only` fails after WIP commit (tip moved) — use `git rebase origin/DOWNSTREAM`.

## Phase 3 — Rebase

```sh
git rebase --onto upstream/main <FORK_POINT> DOWNSTREAM
```

Default: linearizes; `Merge PR #…` wrappers drop, content replays clean. State this to user. `--rebase-merges` only if topology must be preserved.

### Conflicts

```sh
git add <file>
git -c core.editor=true rebase --continue
```

`git show upstream/main:path` for the authoritative upstream side.

- Both sides advance same code → keep both; adopt upstream identifier if renamed
- Additive (distinct methods) → keep both; check brace balance, no duplicate keys
- Dangling fork-rename refs after supersede → remove

**Post-merge structural bugs:**
- Extra `}` → "Illegal return statement" + cascading errors. Check brace balance at every merged method boundary.
- Flattened indentation → block loses tabs at column 0. Verify tab depth after each multi-line merge.

## Phase 4 — Verify

```sh
git rev-list --left-right --count upstream/main...DOWNSTREAM  # expect: 0 <N>
git status                      # must be clean
```

**Native rebuild** — MUST run when upstream touched `crates/*`, `packages/natives/`, or any native export:

```sh
bun run build:native   # compiles Rust + pi-natives; regenerates *.node + packages/natives/index.js
```

> `bun check`/`bun build` never invoke the Rust toolchain → stale `.node` after crate changes → exports (e.g. `editDescription`) are `undefined` at runtime. Run before project check.

After rebuild: `oma --version` / `oma --help` work; native exports load as functions, not `undefined`.

```sh
<project-check>                  # bun check; fix every error
<test-command> <fork-test-files>
```

Post-rebase fixes are uncommitted edits — MUST commit before pushing (`fix(scope): reconcile after rebase`); re-run check after commit.

Test failing on clean `upstream/main` worktree (`git worktree add /tmp/up-ck upstream/main`) → pre-existing upstream issue; do not chase.

## Phase 5 — Push

```sh
git push --force-with-lease origin DOWNSTREAM:DOWNSTREAM
git push origin DOWNSTREAM:DOWNSTREAM  # after post-rebase fix commits
git rev-list --left-right --count upstream/main...origin/DOWNSTREAM
git log --oneline -1 origin/DOWNSTREAM
```

Report: fork point · commits replayed · conflicts resolved (policy applied) · check/test results · pre-existing failures confirmed.
