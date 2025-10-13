---
description: Create isolated worktree for agent workflows—defaults to dev base branch
argument-hint: <name> [--issue N] [--base dev] [--agent ID] [--lock] [--install]
allowed-tools:
  - Bash("~/.claude/plugins/marketplaces/bengolea-plugins/orchestration/scripts/worktree/worktree":create)
model: claude-sonnet-4-5
---

Create a new managed worktree with optional issue tracking, agent locking, and automatic dependency installation. The worktree is created as a new git branch based on the specified base branch (default: `dev`).

**Branch naming:**
- Without `--issue`: `worktree/<name>` or `worktree/<name>-<agent>`
- With `--issue N`: `worktree/<issue>-<name>` or `worktree/<issue>-<name>-<agent>`

**Common patterns:**

```bash
# Personal workspace with lock and dependencies
/worktree:create my-feature --agent me --lock --install

# Delegate to subagent with issue tracking
/worktree:create api-work --issue 123 --agent subagent1 --lock

# Feature staging on non-dev base
/worktree:create hotfix --base staging --agent me --lock

# Simple worktree without extras
/worktree:create experiment
```

**Flags/Arguments:**

- `<name>` (required) - Worktree identifier (will be slugified)
- `--issue N` - Associate with GitHub issue number (appears in branch name)
- `--base <branch>` - Base branch to fork from (default: `dev`)
- `--agent <id>` - Agent identifier (appears in branch name)
- `--lock` - Immediately lock for the specified agent (requires `--agent`)
- `--install` - Run `pnpm install` after creation (see `/worktree:bootstrap`)

**Default behavior:**

- Base branch: `dev` (always fetch from `origin/dev` first)
- Creates new branch and worktree in parallel file tree
- Registers worktree in management system with metadata
- Does NOT lock unless `--lock` is specified

**Related commands:**

- `/worktree:lock` - Lock worktree for exclusive agent access
- `/worktree:open` - Get path and branch for delegation
- `/worktree:guide` - Learn workflow patterns

!"~/.claude/plugins/marketplaces/bengolea-plugins/orchestration/scripts/worktree/worktree" create $ARGUMENTS
