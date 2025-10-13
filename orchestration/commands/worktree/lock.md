---
description: Lock worktree for exclusive agent access with automatic TTL expiration
argument-hint: <name> --agent ID [--reason TEXT] [--ttl 6h] [--force]
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree":lock)
model: claude-sonnet-4-5
---

Lock a worktree for exclusive agent access with automatic time-to-live (TTL) expiration. Prevents concurrent modifications and enables safe delegation workflows.

**TTL format:**
- `30m` - 30 minutes
- `6h` - 6 hours (default)
- `2d` - 2 days

Locks automatically expire after TTL but file remains. Use `/worktree:who` to check expiration status.

**Common patterns:**

```bash
# Standard lock with default 6h TTL
/worktree:lock my-feature --agent me

# Short-lived lock with reason
/worktree:lock experiment --agent me --ttl 30m --reason "Quick test"

# Long-lived lock for multi-day work
/worktree:lock api-refactor --agent me --ttl 2d --reason "Major refactoring"

# Force lock (overwrite existing lock)
/worktree:lock stuck-work --agent me --force
```

**Flags/Arguments:**

- `<name>` (required) - Worktree identifier
- `--agent <id>` (required) - Agent identifier claiming the lock
- `--reason <text>` - Optional explanation for lock
- `--ttl <duration>` - Lock expiration time (default: `6h`)
- `--force` - Override existing active lock

**Behavior:**

- Fails if active lock exists (unless `--force`)
- Accepts lock if lock is expired
- Records agent, TTL, reason, PID, and expiration timestamp
- Logged as event in worktree history

**Related commands:**

- `/worktree:who` - Check current lock owner and expiration
- `/worktree:unlock` - Release lock ownership
- `/worktree:transfer` - Transfer lock between agents

**Your task:**

Execute the script to perform the lock operation:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree" lock $ARGUMENTS
```

The script is already permitted via allowed-tools. Run it and report the results.