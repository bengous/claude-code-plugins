---
description: Health check all managed worktrees for issues
argument-hint:
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Perform comprehensive health check on all managed worktrees to detect inconsistencies between metadata and actual git state.

**Common patterns:**

```bash
# Run health check
/worktree:doctor

# After git operations that might break sync
git worktree prune
/worktree:doctor

# Before major cleanup operations
/worktree:doctor
/worktree:prune --merged --force
```

**Checks performed:**

1. **Path existence**: Verifies worktree directory exists on filesystem
2. **Branch existence**: Verifies git branch exists in repository
3. **Metadata sync**: Checks management metadata matches git state

**Example output (issues found):**

```
Missing path for my-feature: /path/to/worktree/my-feature
Branch missing for api-work: worktree/123-api-work
2 issue(s) detected
```

**Example output (healthy):**

```
All worktrees healthy
```

**Common issues:**

1. **Missing path**: Worktree directory deleted outside management system
2. **Missing branch**: Branch deleted manually with git
3. **Desync**: Metadata out of sync with git state

**When to run:**

1. **After manual git operations**: If you used raw `git worktree` commands
2. **Periodic maintenance**: Regular health checks
3. **Before bulk operations**: Ensure clean state before prune/delete
4. **Debugging**: When worktree commands behave unexpectedly

**Fixing issues:**

- Missing path: Use `/worktree:delete <name> --force` to clean up metadata
- Missing branch: Use `/worktree:delete <name> --force` or recreate with `/worktree:attach`
- For unmanaged existing worktrees: Use `/worktree:attach` to adopt them

**Related commands:**

- `/worktree:attach` - Adopt existing unmanaged worktrees
- `/worktree:delete` - Remove worktree (use `--force` for broken ones)
- `/worktree:prune` - Bulk cleanup operations

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "/home/b3ngous/projects/claude-plugins/orchestration"`

**Your task:**

Execute the worktree management script:

```bash
<plugin-location-from-above>/scripts/worktree/worktree doctor $ARGUMENTS
```

Show the full output to the user.