---
description: Show workflow patterns and best practices for agent collaboration
argument-hint:
allowed-tools:
  - Bash("~/.claude/plugins/marketplaces/bengolea-plugins/orchestration/scripts/worktree/worktree":guide)
model: claude-sonnet-4-5
---

Quick reference guide showing recommended workflow patterns and best practices for agent collaboration using managed worktrees.

**Philosophy:** Stay on `dev` unless isolation is explicitly needed.

**Workflow 1: Handle task inline (no worktree)**

Work directly on `dev` branch for simple tasks that don't need isolation.

```bash
# Just do the work on dev
git checkout dev
# ... make changes, commit, push
```

**Workflow 2: Main agent personal workspace**

Create isolated workspace for complex work requiring separation from main branch.

```bash
# Create locked worktree with dependencies
/worktree:create my-feature --lock --agent me --install

# Work inside the worktree
# Check status as needed
/worktree:status my-feature

# After completion: merge and cleanup
/worktree:merge my-feature
/worktree:delete my-feature
```

**Workflow 3: Delegate to subagent**

Create worktree, delegate to subagent, and manage handoff.

```bash
# Create for subagent with issue tracking
/worktree:create api-work --issue 123 --agent subagent1 --lock --install

# Get path and share with subagent
/worktree:open api-work

# Kick off via Task tool
# Pass worktree path to subagent

# After subagent finishes: unlock or transfer
/worktree:unlock api-work --force
/worktree:merge api-work
/worktree:delete api-work
```

**Workflow 4: Feature staging (non-dev base)**

Create worktree from non-dev branch for staging or hotfix work.

```bash
# Create from staging branch
/worktree:create hotfix --base staging --agent me --lock

# Work and merge back to staging
/worktree:merge hotfix --to staging
/worktree:delete hotfix
```

**State inspection commands:**

```bash
/worktree --json              # Overview of all managed worktrees
/worktree:who my-feature      # Check lock owner and TTL
/worktree:status my-feature   # Git status details
/worktree:logs my-feature     # Event history
```

**Cleanup patterns:**

```bash
# Safe cleanup of merged work
/worktree:prune --merged --force

# Aggressive cleanup (merged OR stale 7 days)
/worktree:prune --merged --stale 168 --force

# Health check
/worktree:doctor
```

**Best practices:**

1. **Default to dev**: Only create worktrees when isolation is needed
2. **Lock for exclusivity**: Use `--lock` when creating for agent work
3. **Install dependencies**: Add `--install` to avoid manual bootstrap
4. **Track issues**: Use `--issue` for GitHub issue integration
5. **Clean up promptly**: Delete worktrees after merging

**Related commands:**

- `/worktree` - List all worktrees
- `/worktree:create` - Create new worktree
- `/worktree:delete` - Remove worktree

!"~/.claude/plugins/marketplaces/bengolea-plugins/orchestration/scripts/worktree/worktree" guide $ARGUMENTS
