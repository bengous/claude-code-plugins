---
description: Get absolute path and branch name for a managed worktree
argument-hint: <name>
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Retrieve the absolute filesystem path and git branch name for a managed worktree. Essential for delegation workflows where you need to share worktree location with subagents.

**Output format:**
- Line 1: Absolute path to worktree directory
- Line 2: Git branch name

**Common patterns:**

```bash
# Get worktree info for delegation
/worktree:open my-feature

# Typical delegation workflow
/worktree:create api-work --issue 123 --agent subagent1 --lock
/worktree:open api-work
# Share the path output with subagent via Task tool

# Check worktree location before running commands
/worktree:open experiment
/worktree:exec experiment -- pnpm test
```

**Use cases:**

1. **Delegation**: Share worktree path with subagents
2. **Scripting**: Get path for custom automation
3. **Verification**: Confirm worktree location before operations

**Example output:**

```
/home/user/projects/.worktrees/moment-photographie/api-work
worktree/123-api-work-subagent1
```

**Related commands:**

- `/worktree:create` - Create worktree before opening
- `/worktree:exec` - Execute commands in worktree
- `/worktree:status` - Show detailed git status

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "/home/b3ngous/projects/claude-plugins/orchestration"`

**Your task:**

Execute the worktree management script:

```bash
<plugin-location-from-above>/scripts/worktree/worktree open $ARGUMENTS
```

Show the full output to the user.