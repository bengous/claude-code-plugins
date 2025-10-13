---
description: Show detailed git status of a specific worktree
argument-hint: <name>
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree":status)
model: claude-sonnet-4-5
---

Display comprehensive git status information for a managed worktree including path, branch, commit, tracking branch, and working directory changes.

**Output includes:**
- Absolute filesystem path
- Current branch name
- Latest commit SHA (short)
- Tracking branch
- Working directory changes (if any) or "Clean"

**Common patterns:**

```bash
# Check status before merge
/worktree:status my-feature
/worktree:merge my-feature

# Verify clean state before deletion
/worktree:status experiment
/worktree:delete experiment

# Diagnose issues reported by subagent
/worktree:status api-work
```

**Example output (with changes):**

```
Path: /home/user/projects/.worktrees/moment-photographie/my-feature
Branch: worktree/my-feature-me
Commit: a1b2c3d
Tracking: dev
Changes:
 M src/app/page.tsx
?? src/components/new-feature.tsx
```

**Example output (clean):**

```
Path: /home/user/projects/.worktrees/moment-photographie/my-feature
Branch: worktree/my-feature-me
Commit: a1b2c3d
Tracking: dev
Clean
```

**Use cases:**

1. Pre-merge validation
2. Debugging worktree issues
3. Verifying clean state
4. Checking uncommitted changes

**Related commands:**

- `/worktree` - List all worktrees and their states
- `/worktree:merge` - Merge worktree branch
- `/worktree:delete` - Delete worktree

**Your task:**

Execute the script to perform the status operation:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree" status $ARGUMENTS
```

The script is already permitted via allowed-tools. Run it and report the results.