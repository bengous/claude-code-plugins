---
name: git-sweep
description: >
  Clean stale git branches and worktrees interactively. Audits local/remote
  branches, proves which ones the base already contains (including after a
  squash or rebase), frees finished worktrees, and confirms before deleting.
  Use when: "git sweep", "sweep branches", "branch cleanup",
  "prune stale branches", "clean up agent worktrees".
disable-model-invocation: true
argument-hint: "[base-branch]"
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-audit.ts":*)
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-apply.ts":*)
  - Bash(printf:*)
  - Bash(test:*)
  - Bash(echo:*)
  - Bash(git log:*)
  - Bash(git diff:*)
  - Bash(git symbolic-ref:*)
  - Bash(git rev-parse:*)
  - Bash(git branch:*)
  - Bash(git for-each-ref:*)
  - Bash(git status:*)
  - Bash(git worktree list:*)
  - Read
  - Write
  - Grep
  - Glob
---

# Git Sweep

Route to the correct cleanup phase based on repo state. The phase files
`audit.md` and `apply.md` live in this skill's base directory.

## Inputs

- base: $ARGUMENTS
  (optional: the base branch to audit against, e.g. `/git-sweep dev`;
  empty lets the backend resolve the trunk: git config sweep.base,
  then origin/HEAD, then main/master/trunk)
- branch: !`git branch --show-current`
- repo: !`git rev-parse --show-toplevel`
- worktrees: !`git worktree list`
- pending: !`test -f "$(git rev-parse --absolute-git-dir)/git-sweep-manifest.json" && echo "yes" || echo "no"`
- tools: !`test -x "${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-audit.ts" && test -x "${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-apply.ts" && echo "ok" || echo "missing"`

## Routing

```
if tools == "missing":
  STOP — tell user: git-clean-audit and/or git-clean-apply not executable.
  Run: chmod +x "${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-audit.ts" "${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-apply.ts"

if pending == "yes":
  # A previous run left operations unexecuted (partial failure, or an
  # interrupted hand-off). The file holds an already-confirmed selection.
  AskUserQuestion:
    header:   "Manifest"
    question: "A pending cleanup manifest exists. Apply it, or re-audit?"
    options:  "Apply pending manifest (Recommended)"
              | "Re-audit (overwrites it)"
  if "Apply pending manifest":
    Read apply.md and follow it
    (do not continue below)

Read audit.md and follow it
```

The audit phase handles all "nothing to clean" detection itself
(local branches, remote branches, worktrees). Do not short-circuit here.

## Configuration (git config, all optional)

- `sweep.base` — trunk to audit against when no argument is given
- `sweep.protect` (multi-valued) — extra branches never proposed for deletion
- `sweep.unprotect` (multi-valued) — lift names from the default protected
  set (main, master, trunk, dev, develop); the audited base stays protected
- `sweep.agentPrefix` / `sweep.backupPrefix` — classification prefixes
  (defaults `worktree-agent-`, `backup/`; they must not overlap)
- `sweep.maxAgeDays` — age bound for the containment test (default 180)

Suggest the right key when a repo needs it (custom trunk name, other branch
conventions); never set one without the user asking.
