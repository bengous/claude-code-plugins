---
description: Worktree management - create, list, delete, lock, and monitor isolated git worktrees
argument-hint: <command> [args]
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree":*)
model: claude-sonnet-4-5
---

Manage isolated git worktrees for parallel development workflows.

**Available commands:**

**Core operations:**
- `list [--json]` - List all managed worktrees
- `create <name> [options]` - Create new worktree
- `open <name>` - Get worktree path and branch (for delegation)
- `status <name>` - Show git status of worktree
- `delete <name> [options]` - Delete worktree

**Lock management:**
- `lock <name> --agent ID [options]` - Lock worktree for exclusive access
- `unlock <name> [--agent ID] [--force]` - Release lock
- `who <name>` - Show current lock owner and expiration

**Maintenance:**
- `prune [--merged] [--stale HOURS] [--force]` - Clean up old worktrees
- `doctor` - Health check for all worktrees

**Common usage patterns:**

```bash
# Create worktree for feature work
/orc:wt create my-feature --base dev --agent me --lock

# Get worktree info for delegation
/orc:wt open my-feature
# Returns: /path/to/worktree (line 1), branch-name (line 2)

# Check status
/orc:wt status my-feature

# List all worktrees
/orc:wt list

# Clean up merged worktrees
/orc:wt prune --merged --force

# Delete specific worktree
/orc:wt delete my-feature
```

**Create command options:**
- `--base <branch>` - Base branch to fork from (default: dev)
- `--agent <id>` - Agent identifier (appears in branch name)
- `--lock` - Immediately lock for agent (requires --agent)
- `--issue <N>` - Associate with GitHub issue number
- `--branch <name>` - Override automatic branch naming

**Delete command options:**
- `--keep-branch` - Keep branch after removing worktree
- `--force` - Delete even if not merged

**Lock command options:**
- `--reason <text>` - Lock reason description
- `--ttl <duration>` - Lock time-to-live (default: 6h)
- `--force` - Override existing lock

**Prune command options:**
- `--merged` - Select worktrees merged to base
- `--stale <hours>` - Select worktrees older than N hours
- `--force` - Actually delete (without --force, shows candidates only)

Execute the backend script with provided arguments:

!"${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree" $ARGUMENTS
