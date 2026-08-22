---
description: Interactive git rebase with a visual plan and reworked commit messages
argument-hint: <branch|N|X..Y> | continue | skip | abort | status
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/rebase.ts":*)
  - Bash(printf:*)
  - Bash(git log:*)
  - Bash(git show:*)
  - AskUserQuestion
model: opus
---

# Interactive Rebase

Rewrite the commits of the current branch: keep, squash, reword or drop each one.

`$ARGUMENTS` selects the range, or names a follow-up:

| Argument | Meaning |
|----------|---------|
| `N` | the last N commits (`HEAD~N`) |
| `<rev>` | every commit since the merge base with `<rev>` — it edits those commits, it does not move the branch onto `<rev>` |
| `X..Y` | every commit since `X` |
| `continue` \| `skip` \| `abort` \| `status` | act on a rebase that stopped on a conflict |

The backend never opens an editor and never prompts. It prints one JSON object
per call; you ask the questions and feed the answers back in. **You** write the
message suggestions in Phase 3 — no separate model is called, and nothing here
invents a suggestion the user did not see.

## Phase 0: Follow-ups

If the argument is `continue`, `skip`, `abort` or `status`, run that mode and
stop:

```
run `"${CLAUDE_PLUGIN_ROOT}/scripts/rebase.ts" {argument}`
```

Report `step` on success. On `ok: false`, report `error` and `detail`; when
`guidance` is present, print every line of it. Then stop — no other phase runs.

`exec-failed` on `continue` or `skip` means a commit message was never applied
and neither mode can replay it. Say so, and offer `/rebase abort` — never retry
the same mode. `backup_ref`, when set, names the branch that still holds the
history as it was before the rebase started.

## Phase 1: Plan

```
run `"${CLAUDE_PLUGIN_ROOT}/scripts/rebase.ts" plan {argument}`
capture: exit_code, stdout, stderr

if stdout is empty OR is not valid JSON:
  STOP — report "rebase backend failed" with exit_code and stderr

plan = parse stdout as JSON

if plan.ok == false:
  STOP — report plan.error and plan.detail:
    not-a-git-repo             the command needs a git repository
    dirty-worktree             commit or stash first; detail lists the files
    rebase-already-in-progress finish it with /rebase continue, skip or abort
    invalid-range              detail says which revision was rejected

if plan.commits is empty:
  STOP — tell the user there is nothing to rebase in that range
```

Show `plan.note` when it is not null.

## Phase 2: Show the commits

One row per commit, oldest first — that is the order the rebase replays them:

```
| # | Commit | Subject | Author | Age | Changes |
```

`Changes` is `{files} files, +{insertions}/-{deletions}`. Keep the numbering:
Phase 3 refers to it.

## Phase 3: Ask for an action per commit

Batch the commits 4 at a time into `AskUserQuestion` calls, one question per
commit (`header` = the short hash), with these four options:

| Option | Effect |
|--------|--------|
| Pick | keep the commit unchanged |
| Squash | fold it into the commit above it |
| Reword | change its message |
| Drop | remove it from history |

Two rules the backend enforces, so do not offer what it will reject: the first
commit that is not dropped cannot be squashed, and a reword needs a message.

For every commit answered **Reword** or **Squash**, write the message yourself
and confirm it before it is used:

```
Read the commit: `git show --stat {hash}` (add `git show {hash}` when the
subject alone does not say what changed).

Reword — propose 2 or 3 subjects, then ask which one with AskUserQuestion,
  always with a "Write my own" option:
    - the original, unchanged
    - a conventional-commit form (type(scope): subject) when the repo's
      history uses one — read `git log --format=%s -20` to check
    - a shorter subject, 50 characters or less
  Keep the original body unless the user asks otherwise: send subject, a blank
  line, then the body, so the amend does not drop it.

Squash — propose one message for the combined commit, from the messages of
  every commit folded into it, and ask the user to accept or replace it.
```

Never invent a scope, a ticket number or a claim the diff does not support.

## Phase 4: Build the plan

```
steps = for each commit, in the order of Phase 2:
  { hash: commit.hash, action: "pick"|"squash"|"reword"|"drop", message: … }

message rules — the backend rejects anything else:
  pick, drop     message = null
  reword         message = the chosen message (subject, and the body if kept)
  squash         message = the combined message, on the LAST squash of a run of
                 consecutive squashes; null on the others
```

A `message` always names the commit that exists **after** that step: for a
squash, that is the combined commit.

## Phase 5: Confirm the plan

```
run `printf '%s' '{"base": "{plan.base}", "steps": {steps_json}}' \
  | "${CLAUDE_PLUGIN_ROOT}/scripts/rebase.ts" apply --dry-run`
```

Print `plan_text` verbatim — that is the visual plan. On `ok: false`, report
`error` and `detail`, then:

```
plan-stale         the branch moved since Phase 1 — start over at Phase 1
plan-invalid       the steps break a rule; detail says which. Fix them in
                   Phase 4 and re-run this phase. Do NOT restart Phase 1:
                   the plan is not stale and a fresh one repeats the fault.
base-not-ancestor  the base is not behind HEAD; that is a transplant, not an
                   edit. Start over at Phase 1 to get a real base.
invalid-plan       the JSON is malformed — rebuild it in Phase 4
```

Then ask once with `AskUserQuestion`: "Run this rebase?" — Run / Cancel. On
Cancel, stop and change nothing.

## Phase 6: Execute

Same call without `--dry-run`. Say first that a backup branch is created, so
nothing is lost.

```
if result.ok == true:
  Report: {result.commits} commits now on the branch, backup at
  {result.backup_ref}. Add: delete it with `git branch -D {backup_ref}` once
  the history looks right.

if result.error == "conflict":
  The rebase paused at commit {state.current} of {state.total}.
  List state.conflicted — "{path} ({markers} conflicts)" — then print every
  line of result.guidance. Stop there: the user resolves, then runs
  /rebase continue. Do NOT resolve the conflict without being asked to.

if result.error == "exec-failed":
  A commit message could not be applied and the rebase is paused mid-way.
  Print detail verbatim. Do NOT suggest /rebase continue: it skips the
  failed step and the message is lost for good. The way out is
  /rebase abort, then fix the cause, then /rebase again.

if result.error == "rebase-stopped":
  The rebase paused for a reason that is neither a conflict nor a message.
  Print detail — it holds git's own stderr — and let the user decide.

any other error:
  Report error and detail. The branch is untouched unless backup_ref is set,
  in which case `git reset --hard {backup_ref}` restores it.
```

`backup_ref` is reported on every result once the backup exists, failures
included, so the way back is always in the last message the user saw.

## Safety

- The plan is refused while tracked files have uncommitted changes. Untracked
  files are left alone, as `git rebase` leaves them alone.
- A backup branch (`rebase-backup-<branch>-<timestamp>`) is created before the
  first commit is rewritten, and it is reported on every later result.
- The base must be an ancestor of HEAD, so the rebase edits the branch instead
  of moving it somewhere else.
- The plan is re-checked against the branch at execution time; a plan whose
  commits moved is rejected instead of applied to the wrong ones.
- Conflicts pause the rebase and leave it resumable. Nothing auto-resolves.
- A commit message that cannot be applied stops the run and says so. It is
  never reported as success.
