---
name: squash
description: Squash git commits by pattern, hash list, or the last N, without opening an editor. Use when the user asks to squash, fold, or combine commits, or to collapse fixup and WIP commits.
argument-hint: --pattern <regex> | --hashes <h1,h2,...> | --range <N> [--dry-run]
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/rebase.ts":*)
  - Bash(printf:*)
  - Bash(git log:*)
  - Bash(git rev-parse:*)
  - AskUserQuestion
---

# Squash

Fold a run of commits into one. The rebase backend of this plugin does the
rewrite: it builds the todo, sets the editors inside its own process, creates
a timestamped backup branch, re-checks the plan against the branch, and leaves
a conflict resumable. This skill only chooses which commits fold.

## Arguments

`$ARGUMENTS`

| Mode | Selection |
|---|---|
| `--range N` | the last N commits, folded into the oldest |
| `--hashes h1,h2,...` | the listed commits, folded into the oldest of them |
| `--pattern <regex>` | every commit whose subject matches, case-insensitive, folded into the oldest match |
| `--dry-run` | validate and print the plan, rewrite nothing |

## Protocol

1. **Range.** `--range N`: the range is `N`. Otherwise the range is the branch:
   `origin/dev` when it exists, else the remote default branch
   (`git rev-parse --abbrev-ref origin/HEAD`). No remote at all, or on that
   branch itself: ask how far back to look, and use `N`.

   ```
   run `"${CLAUDE_PLUGIN_ROOT}/scripts/rebase.ts" plan {range}`
   ```

   On `ok: false`, report `error` and `detail` and stop: `dirty-worktree`
   lists the files to commit or stash first, `rebase-already-in-progress`
   points at `/git:rebase continue|skip|abort`.

2. **Targets.** From `plan.commits`, oldest first: the commits whose hash
   starts with a listed hash, or whose subject matches the pattern. Fewer
   than two targets: say so and stop. A listed hash outside the range: name
   it and stop.

   The targets must be consecutive. The backend folds a `squash` into the
   commit right above it, never across a kept commit: with `fixA, other,
   fixB` the second fix would fold into `other`. Non-consecutive targets:
   list the commits sitting between them and stop; `/git:rebase` on the
   range is the tool for that case.

3. **Message.** Read each target with `git log -1 --format=%B <hash>` and
   compose one message for the combined commit: a subject in the convention
   of `git log --oneline -10`, then the bodies that still hold. Print it.

4. **Steps.** One step per commit of the range, in the order of
   `plan.commits`:

   ```
   pick         every commit outside the targets, message null
   pick         the oldest target, message null
   squash       every later target; message null, except the LAST one,
                which carries the combined message
   ```

5. **Apply.**

   ```
   run `printf '%s' '{"base": "{plan.base}", "steps": {steps_json}}' \
     | "${CLAUDE_PLUGIN_ROOT}/scripts/rebase.ts" apply [--dry-run]`
   ```

   With `--dry-run` in `$ARGUMENTS`, pass it through: print `plan_text` and
   stop. Without it, the backend rewrites and reports. On `ok: true`: the
   new tip, `result.commits` commits on the branch, and `backup_ref`, with
   `git branch -D {backup_ref}` as the way to drop it once the history looks
   right.

   On `ok: false`: `plan-stale` means the branch moved, start over at step 1;
   `conflict` pauses the rebase, print every line of `guidance` and stop, the
   user resolves and runs `/git:rebase continue`; `exec-failed` means the
   message was not applied, offer `/git:rebase abort`, never `continue`. Any
   other error: report `error` and `detail`; `backup_ref`, when set, restores
   the branch with `git reset --hard`.
