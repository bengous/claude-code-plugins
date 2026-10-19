---
name: auto-sweep
description: >
  Clean leftover local branches and agent worktrees with no prompt: deletes the
  branches git-sweep proves are already in the base, removes the clean agent
  worktrees (.claude/worktrees/agent-*) standing on them, and archives under
  refs/archive/ the agent branches abandoned past a threshold. Never touches a
  remote ref, a protected or current branch, or a worktree with changes.
  Use when a session ends, after landing a branch, or when leftover agent
  worktrees and branches pile up.
argument-hint: "[--dry-run] [--base <branch>]"
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/auto-sweep.ts *)
---

# Auto Sweep

The script decides everything: which base to judge against, which branch is
proven, which agent branch is abandoned. Run it, then relay its summary.

## Run

```
"${CLAUDE_PLUGIN_ROOT}/scripts/auto-sweep.ts" $ARGUMENTS
```

One plain command, nothing appended. It works from any checkout of the
repository; the checkout it runs in is current, so its branch and worktree stay.

- `--dry-run` prints the same summary and changes nothing. Use it when the
  user asks what a sweep would do.
- `--base <branch>` names the base. Without it the script takes `sweep.base`,
  then `dev` or `develop`, then origin/HEAD, then main, master or trunk.

Exit 0 means every operation went through; 1 means the audit failed (reason
on stderr) or an operation failed (listed under `Failed`); 2 means a bad
argument.

## Report

Relay the summary in a few lines: how many branches were deleted, which agent
worktrees were removed, and every archived branch with its restore command,
`git branch <name> refs/archive/<name>`. Name the kept branches only when the
user asks, or when one looks like work the user is waiting on.

Leave what the script kept as it is: do not delete, unlock or prune by hand.
An unproven branch that is not an agent's, a worktree outside
`.claude/worktrees/agent-*`, a backup branch and every remote branch are the
interactive `/git-sweep`'s to judge, with the user.

## What it decides

| Case | Outcome |
|------|---------|
| Branch proven in the base (ancestry, no merge delta, merged PR) | deleted |
| Clean agent worktree on a proven branch, ignored directories only | removed, branch deleted |
| Agent worktree whose directory is gone | registration dropped |
| Unproven agent branch, PR closed unmerged and last commit both 14+ days old | archived, then deleted with its clean worktree |
| Unproven agent branch, no PR, last commit 30+ days old | archived, then deleted with its clean worktree |
| Base, protected, current, locked, dirty, or holding ignored files | kept |
| Agent branch whose agent still runs (its worktree is locked) | kept |
| Remote branches and tracking refs | never deleted |

An agent branch is one named with `sweep.agentPrefix` (default
`worktree-agent-`) or checked out only in an agent worktree.
