# Git Sweep Apply

Confirm manifest, execute, report results.

Paths: this file lives in `<plugin>/skills/git-sweep/`; the backends live in
`<plugin>/scripts/` — two directories above this file.

Two standing rules:

- Keep every Bash call inside the command heads SKILL.md pre-approves. No
  `; echo $?` suffix, no ad-hoc `grep`/`head` — each extra head falls outside
  the approval and triggers a permission prompt. A failing command already
  reports its exit code in the tool result.
- STOP means stop: report the stated message and end the turn. Do not read the
  backend source, run substitute git commands, or improvise deletions by hand.

## Inputs

The audit phase persists `{manifest, kept}` to a fixed repo-scoped file before
handing off, so this phase works from a fresh context (compaction-proof):

```
manifest_file = run `git rev-parse --absolute-git-dir`/git-sweep-manifest.json

# In a linked worktree that path is <repo>/.git/worktrees/<name>, so apply must
# run from the same worktree the audit ran in.
if manifest_file does not exist:
  STOP — tell user: no pending manifest here; run /git-sweep to audit first
         (if the audit ran in another worktree, re-run it from this one)

read manifest_file → { manifest, kept }
```

- `manifest`: the CleanupManifest JSON to execute — carries `base` and, per
  branch, the `oid` the audit judged
- `kept`: branches automatically retained, each with its reason

## Phase 1: Present summary

```
Count operations:
  wt_count     = len(manifest.worktrees)
  br_safe      = count where force == false in manifest.branches
  br_force     = count where force == true in manifest.branches
  remote_count = len(manifest.remote_branches)

Display:
  "Will delete:"
  "  Worktrees:        {wt_count}"
  "  Local branches:   {br_safe + br_force} ({br_safe} safe, {br_force} force)"
  "  Remote branches:  {remote_count}"
  "  Prune refs:       {yes/no based on prune_remotes or prune_worktrees}"
  ""
  "Retained (base {manifest.base} is never deleted):"
  one line per kept entry: "  {name} — {reason}{: detail if present}"
```

Example output:
```
Will delete:
  Worktrees:        14
  Local branches:   28 (14 safe, 14 force)
  Remote branches:  19
  Prune refs:       yes

Retained (base main is never deleted):
  main                    — base
  dev                     — current
  feature/live-work       — dirty-worktree: /home/user/p/.wt/live
  research/state-of-art   — unproven: 1 commit(s) not proven to be in main
```

## Phase 2: Confirm

```
loop:
  AskUserQuestion:
    header:   "Cleanup"
    question: "Run these N operations? Remote deletions cannot be undone."
    options:  "Execute cleanup (Recommended)" | "Review details" | "Abort"

  if "Abort":
    STOP — tell user: nothing was changed

  if "Review details":
    Show full manifest:
      - each worktree path
      - each branch with force flag
      - each remote branch
    continue loop  // ask again after review

  if "Execute cleanup":
    break loop
```

## Phase 3: Execute

Run the apply backend against the saved manifest file. It re-validates the
manifest shape, executes one operation at a time, and consumes (deletes) the
file on full success. (`--manifest '{json}'` still works for direct invocation.)

```
result = run `"<plugin>/scripts/git-clean-apply.ts" --manifest-file "{manifest_file}"`
capture: stdout, stderr

# Same always-JSON guard as the audit phase: empty / non-JSON stdout means the
# backend never started.
if stdout is empty OR stdout is not valid JSON:
  STOP — report "apply backend failed" with stderr

parse stdout as JSON → result
```

If the run is **blocked by permissions** rather than by git — the backend was
never allowed to run — do not improvise a series of one-off commands. Go to
Phase 6 and hand the user a script.

## Phase 4: Report

```
if result.ok == false AND result.error exists:
  STOP — report error (e.g., invalid manifest)
  Suggest: "Run /git-sweep again to re-audit current state"

group result.operations by type:
  successes = operations where success == true
  failures  = operations where success == false

# Execution order, so the report reads like the run.
for each type in ["worktree-remove", "prune-worktree", "branch-delete", "remote-delete", "prune-remote", "manifest-rewrite"]:
  if any successes of this type:
    list them with checkmark
  if any failures of this type:
    list them with error message

Display: "{result.summary.succeeded} succeeded, {result.summary.failed} failed"
```

A failed operation is not always a problem to retry — read the error:

- `moved since the audit` — the branch got new commits after it was judged.
  The containment proof no longer covers it. Re-audit, never force by hand.
- `stale info` on a remote delete — someone pushed to that branch since the
  audit. The lease did its job. Re-audit.
- `refusing to delete the base branch` / `the checked-out branch` /
  `the protected branch` — a backend guard fired. Report it as such; the
  manifest was wrong (protected trunks never come from a real audit).
- `contains modified or untracked files` on a worktree — uncommitted work is
  there. Say where, and leave it.
- `used by worktree at ...` — the branch is still checked out somewhere the
  manifest did not remove. The audit builds this pair together; seeing it means
  the worktree was skipped while its branch was kept. Re-audit.
- `conflicting ... entries in the manifest` — the same ref was listed twice
  with different flags. Nothing ran. Re-audit rather than editing the file.

On a partial run the hand-off file survives, **rewritten to hold only what is
left**. Say so explicitly — an unmentioned leftover file is a stale hand-off:

```
if result.manifest_remaining exists:
  Display:
    "{result.manifest_remaining.operations} operation(s) still pending in"
    "{result.manifest_remaining.path}"
    "Run /git-sweep once the cause above is fixed — it detects this file and"
    "offers to retry it as-is, or to re-audit (which overwrites it)."
```

## Phase 5: Final state

```
Run and display:
  `git branch`
  `git branch -r`
  `git worktree list`
```

## Phase 6: Fallback when execution is blocked

Only when permissions refuse the deletions themselves. Write a script the user
runs; do not ask for the permission again, and do not delete anything piecemeal.

Build it from the manifest, and keep these properties — each one exists because
a hand-rolled cleanup got them wrong:

```
- `--dry-run` prints every action and changes nothing; `--yes` skips the
  remote-deletion prompt. Default: local work runs, remote deletion asks.
- Refuses to run from a worktree it is about to remove.
- Skips any worktree with `git status --porcelain` output, and says which.
- Before deleting a local branch, checks its tip still equals the audited oid.
- Deletes remote branches with
  `git push --force-with-lease=refs/heads/<ref>:<audited-oid> origin --delete <ref>`
  so a branch someone pushed to since the audit is refused, not discarded.
- Carries the base branch as untouchable, whatever else the manifest says.
- Prints the reason next to every branch it keeps.
```

Write it to the scratchpad, run `--dry-run` yourself if permissions allow it,
show the user the path and the dry-run output, and tell them the hand-off file
stays until they run it.
