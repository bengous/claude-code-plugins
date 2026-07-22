---
description: Confirm and execute cleanup manifest. Called by /git-sweep-audit.
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-apply":*)
  - Bash(git rev-parse:*)
  - Bash(git branch --list:*)
  - Bash(git branch -r:*)
  - Bash(git worktree list:*)
  - Read
---

# Git Sweep Apply

Confirm manifest, execute, report results.

## Inputs

`/git-sweep-audit` persists `{manifest, kept}` to a fixed repo-scoped file
before handing off, so this command works from a fresh context (compaction-proof):

```
manifest_file = run `git rev-parse --absolute-git-dir`/git-sweep-manifest.json

if manifest_file does not exist:
  STOP — tell user: no pending manifest; run /git-sweep to audit first

read manifest_file → { manifest, kept }
```

- `manifest`: the CleanupManifest JSON to execute
- `kept`: branch names automatically retained (protected/current/active/unclassified)

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
  "Automatically retained: {kept joined by ', '}"
```

Example output:
```
Will delete:
  Worktrees:        0
  Local branches:   28 (14 safe, 14 force)
  Remote branches:  19
  Prune refs:       yes

Automatically retained: main
```

## Phase 2: Confirm

```
loop:
  AskUserQuestion:
    "Execute cleanup" | "Review details" | "Abort"

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
result = run `"${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-apply" --manifest-file "{manifest_file}"`
capture: stdout, stderr

# Same always-JSON guard as the audit phase: empty / non-JSON stdout means the
# backend never started.
if stdout is empty OR stdout is not valid JSON:
  STOP — report "apply backend failed" with stderr

parse stdout as JSON → result
```

## Phase 4: Report

```
if result.ok == false AND result.error exists:
  STOP — report error (e.g., invalid manifest)
  Suggest: "Run /git-sweep again to re-audit current state"

group result.operations by type:
  successes = operations where success == true
  failures  = operations where success == false

for each type in ["worktree-remove", "branch-delete", "remote-delete", "prune-worktree", "prune-remote"]:
  if any successes of this type:
    list them with checkmark
  if any failures of this type:
    list them with error message

Display: "{result.summary.succeeded} succeeded, {result.summary.failed} failed"

if failures exist:
  Suggest: "Run /git-sweep again to retry failed operations"
```

## Phase 5: Final state

```
Run and display:
  `git branch`
  `git branch -r`
  `git worktree list`
```
