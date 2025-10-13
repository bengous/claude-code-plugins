---
description: List and overview managed worktrees
argument-hint: [--json]
allowed-tools:
  - Bash(*:*)
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

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "$HOME/projects/claude-plugins/orchestration"`

**Your task:**

Execute the worktree management script:

```bash
<plugin-location-from-above>/scripts/worktree/worktree list $ARGUMENTS
```

Show the full output to the user.