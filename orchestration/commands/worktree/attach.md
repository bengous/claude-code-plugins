---
description: Adopt existing git worktree into managed system
argument-hint: <branch> [--name NAME] [--path DIR] [--base dev] [--agent ID]
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Adopt an existing git branch into the worktree management system by creating a new worktree from that branch and registering it with full metadata tracking.

**Common patterns:**

```bash
# Adopt existing feature branch
/worktree:attach feature/auth-flow

# Adopt with custom name
/worktree:attach feature/auth-flow --name auth

# Adopt with custom path and agent
/worktree:attach feature/complex --name complex --agent me

# Adopt with non-dev base
/worktree:attach hotfix/security --base staging
```

**Flags/Arguments:**

- `<branch>` (required) - Existing git branch name to adopt
- `--name <name>` - Custom managed name (default: derived from branch name)
- `--path <dir>` - Custom worktree path (default: auto-generated)
- `--base <branch>` - Base branch for tracking (default: `dev`)
- `--agent <id>` - Agent identifier for ownership

**Behavior:**

1. Validates branch exists in repository
2. Creates new git worktree from existing branch
3. Generates managed name (slugified branch name or custom name)
4. Creates management metadata with tracking info
5. Logs attach event

**Name derivation:**

If `--name` not provided:
- Takes branch name (e.g., `feature/auth-flow`)
- Removes `worktree/` prefix if present
- Slugifies to valid identifier (e.g., `feature-auth-flow`)

**Use cases:**

1. **Adopt manual worktrees**: Bring unmanaged worktrees into system
2. **Import existing branches**: Add management to old branches
3. **Migration**: Convert from manual git worktree to managed system
4. **Recovery**: Re-attach after metadata loss

**After attaching:**

The worktree is now fully managed and appears in `/worktree` list. You can use all management commands (`lock`, `status`, `merge`, etc.).

**Related commands:**

- `/worktree:create` - Create new managed worktree from scratch
- `/worktree:doctor` - Check for unmanaged worktrees
- `/worktree` - List all managed worktrees

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration`

**Your task:**

Execute the worktree management script:

```bash
<plugin-location-from-above>/scripts/worktree/worktree attach $ARGUMENTS
```

Show the full output to the user.