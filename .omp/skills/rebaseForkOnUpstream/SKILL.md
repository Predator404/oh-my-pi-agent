---
name: rebaseForkOnUpstream
description: Rebase a downstream fork branch onto the latest upstream main — identify remotes, find the true fork point, fold in uncommitted WIP and unpulled fork commits, replay the fork's changes onto the new base, resolve conflicts with a fork-features-win / upstream-renames-supersede policy, verify, and force-push. Use when asked to pull latest from main and rebase a fork, sync or update a downstream branch off its upstream, catch a diverged fork up to upstream, or refresh fork-only changes against upstream drift.
license: MIT
---

# Rebase fork on upstream

Bring a downstream branch (the fork's work) up to date against the latest
upstream `main`, preserving every fork-only change. History rewrite ahead:
rebase is destructive, so surface choices to the user before rewriting.

## Goal & policy

- Goal: `DOWNSTREAM == upstream/main + all fork commits` (no fork change lost).
- Conflict policy, in order:
  1. **Fork feature vs upstream logic** → keep the fork's feature, adapted to the
     new upstream structure.
  2. **Upstream renamed a symbol/field the fork also carried** → adopt the
     upstream name; the newer upstream implementation supersedes the stale fork
     name (dead fork-rename refs get removed, not kept).
  3. **Two distinct additions landed in the same spot** (different methods,
     imports, object keys) → keep BOTH.
  4. **Pure stylistic fork divergence** (colors, branding, wording) → fork's wins.
- Push uses `--force-with-lease`, never a bare `--force`.

## Phase 1 — Map the topology

Read-only; gather ground truth before touching anything.

```sh
git remote -v                      # upstream = where we forked FROM, origin = the fork
git branch -vv                     # local branches + their tracking/divergence
git status                         # uncommitted work MUST be handled before rebase
git fetch upstream && git fetch origin
git merge-base DOWNSTREAM upstream/main   # true fork point (NOT necessarily origin/main)
git rev-list --count DOWNSTREAM..upstream/main   # how far upstream moved
git rev-list --count upstream/main..DOWNSTREAM   # how many fork commits to replay
git log --oneline upstream/main..DOWNSTREAM      # the exact commit list to replay
```

- The fork point is `git merge-base DOWNSTREAM upstream/main`, not `origin/main`
  (the fork's own `main` is usually stale). Confirm the count of commits to
  replay; it is often far smaller than `upstream/main advance`.
- Check `DOWNSTREAM` vs `origin/DOWNSTREAM`: if behind, the fork has unpulled
  commits on the remote. Those MUST be folded in before rebasing or they'd be
  dropped from the rewritten result.

Decisions to confirm with the user (each has materially different output):

1. **Base**: latest `upstream/main` (where the fork came from) vs the fork's own
   stale `origin/main`. Default: `upstream/main`.
2. **Uncommitted WIP**: commit it onto `DOWNSTREAM` first, or `git stash` (with
   `-u` for untracked). Never discard it. Default: commit.
3. **Unpulled fork commits**: fast-forward to include them. Default: yes.
4. **After rebase**: force-push or leave local for review. Default: confirm.

## Phase 2 — Prepare (fold in work that must survive)

```sh
# WIP committed? then local DOWNSTREAM has diverged from origin/DOWNSTREAM.
git add -A && git commit -m "<coherent WIP summary>"
# Fold in the unpulled fork commits by replaying just the WIP commit on top:
git rebase origin/DOWNSTREAM          # clean, keeps the 5 unpulled commits + WIP
git log --oneline -6 DOWNSTREAM       # confirm tip: WIP over the unpulled commits
```

If you committed WIP, a plain `git pull --ff-only` is no longer possible (the
local tip moved); use `git rebase origin/DOWNSTREAM` instead so the WIP commit
sits on top of the unpulled commits.

## Phase 3 — The rebase

```sh
git rebase --onto upstream/main <FORK_POINT> DOWNSTREAM
```

- Default (no `--rebase-merges`) linearizes: `Merge PR #…` wrapper commits are
  dropped; their content commits replay as a clean sequence. State this to the
  user. (Use `--rebase-merges` only if preserving merge topology is required.)
- Expect conflicts on files both sides touch: changelogs, lockfiles, the fork's
  feature modules, shared renderers.

### Resolving conflicts (apply Phase 1 policy per hunk)

- Read the full 3-way picture, not just the marker text: `git show
  upstream/main:path` tells you the authoritative upstream side; check whether
  the fork-side symbol was renamed upstream.
- Merge upstream's newer structure AND the fork's feature together where both
  advance the same code (e.g. upstream spinner + fork "brand A" marker → keep
  upstream's active-state impl and re-apply the fork's distinguishing marker to
  it). Adopt the upstream identifier when the feature was renamed.
- Additive differences (distinct methods in one spot) → keep both, watching
  brace balance and duplicate keys.
- Remove now-dead fork-rename refs that a rename supersede left dangling;
  a conflicting file may also hold cleanly-auto-merged stale refs elsewhere.

Beware two recurring structural bugs after hand-merging, both from an extra
trailing `}` or flattened indentation:

- **Duplicate/extra closing brace** → "Illegal return statement outside of a
  function" / "Expected a statement but instead found `}`" parser errors, plus
  cascading diagnostics. Check brace balance at every merged method boundary.
- **Flattened indentation** → a REWRITE's first line inherits context indent but
  continuation lines carry their own depth; a block rewritten at column 0 loses
  its tabs. Verify tab depth after each multi-line merge.

```sh
# after resolving a file:
git add <file>
git -c core.editor=true rebase --continue
```

## Phase 4 — Verify

```sh
git rev-list --left-right --count upstream/main...DOWNSTREAM  # 0 <N>: ahead only
git status                      # must be clean
<project-check>                 # e.g. bun check (biome + tsgo); fix every error
<test-command> <fork-test-files># run the fork's own tests, esp. conflict-touched areas
```

- Post-rebase type/lint fixes are uncommitted working-tree edits on top of the
  fresh rebase. Before pushing you MUST commit them (`fix(scope): reconcile
  tests/renderers with upstream after rebase`); otherwise the push ships the
  broken pre-fix state. Re-run the check after committing.
- A failing test whose failure also reproduces on a clean `upstream/main`
  checkout (`git worktree add /tmp/up-ck upstream/main`) is a PRE-EXISTING
  upstream issue, not your regression — do not chase it.

## Phase 5 — Push

```sh
git push --force-with-lease origin DOWNSTREAM:DOWNSTREAM
# then, after committing any post-rebase fixes:
git push origin DOWNSTREAM:DOWNSTREAM   # plain fast-forward, no force needed
# confirm:
git rev-list --left-right --count upstream/main...origin/DOWNSTREAM
git log --oneline -1 origin/DOWNSTREAM
```

Verify `origin/DOWNSTREAM` matches local `DOWNSTREAM`. Report: the fork point,
commits replayed, conflicts resolved (with the policy applied), check/test
results, and the pre-existing (non-regression) failures you confirmed.
