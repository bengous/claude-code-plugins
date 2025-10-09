---
description: List and overview managed worktrees
argument-hint: [--json]
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree":list)
model: claude-sonnet-4-5
---

List all managed worktrees in a table format showing name, path, branch, and lock status. Use `--json` for programmatic access.

**Common patterns:**

```bash
# View all worktrees
/worktree

# Get JSON output for scripting
/worktree --json
```

**Flags/Arguments:**

- `--json` - Output as JSON array for programmatic consumption

**Output format:**

Without `--json`, displays a table with columns:
- **NAME**: Managed worktree identifier
- **PATH**: Absolute filesystem path
- **BRANCH**: Git branch name
- **LOCK**: Lock status (`free`, `<agent>:active`, or `<agent>:expired`)

With `--json`, returns an array of worktree objects including metadata and lock state.

**Related commands:**

- `/worktree:create` - Create new isolated worktree
- `/worktree:status` - Show detailed status of specific worktree
- `/worktree:guide` - Learn workflow patterns and best practices

!"${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree" list $ARGUMENTS
