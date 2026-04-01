---
name: git-sweep
description: >
  Clean stale git branches and worktrees interactively. Audits local/remote
  branches, detects squash-merged and orphaned branches, presents categorized
  cleanup with user confirmation.
  Use when: "git sweep", "sweep branches", "branch cleanup",
  "prune stale branches".
disable-model-invocation: true
---

# Git Sweep

Route to the correct cleanup phase based on repo state.

## Inputs

- branch: !`git branch --show-current`
- repo: !`git rev-parse --show-toplevel | sed 's|.*/||'`
- worktrees: !`git worktree list`
- tools: !`test -x "${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-audit" && test -x "${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-apply" && echo "ok" || echo "missing"`

## Routing

```
if tools == "missing":
  STOP — tell user: git-clean-audit and/or git-clean-apply not executable.
  Run: chmod +x "${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-audit" "${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-apply"

else:
  invoke /git-sweep-audit
```

The audit command handles all "nothing to clean" detection itself
(local branches, remote branches, worktrees). Do not short-circuit here.
