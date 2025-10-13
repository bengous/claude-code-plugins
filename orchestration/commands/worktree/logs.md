---
description: Show event history for a worktree
argument-hint: <name>
allowed-tools:
  - Bash("~/.claude/plugins/marketplaces/bengolea-plugins/orchestration/scripts/worktree/worktree":logs)
model: claude-sonnet-4-5
---

Display timestamped event history for a worktree showing all operations performed including creation, locking, unlocking, transfers, merges, and deletions.

**Common patterns:**

```bash
# View complete history
/worktree:logs my-feature

# Debug lock issues
/worktree:logs stuck-work

# Audit agent activity
/worktree:logs api-work

# Track workflow timeline
/worktree:logs long-running-task
```

**Example output:**

```
[2025-10-06T10:00:00Z] create branch=worktree/my-feature-me base=dev
[2025-10-06T10:00:05Z] lock agent=me ttl=6h
[2025-10-06T14:30:00Z] bootstrap lockfile=a1b2c3d4...
[2025-10-06T16:45:00Z] transfer from=me to=subagent1
[2025-10-06T18:00:00Z] unlock agent=subagent1
[2025-10-06T18:30:00Z] merge into=dev
[2025-10-06T18:31:00Z] delete keep_branch=false
```

**Event types:**

- `create` - Worktree creation with branch and base info
- `attach` - Existing branch adopted into management
- `lock` - Lock acquired with agent and TTL
- `unlock` - Lock released
- `transfer` - Lock ownership transferred
- `bootstrap` - Dependencies installed with lockfile hash
- `annotate` - Custom metadata added
- `merge` - Branch merged into target
- `delete` - Worktree removed

**Log format:**

```
[<ISO 8601 timestamp>] <action> <key=value pairs>
```

**Use cases:**

1. **Debugging**: Trace operations to find issues
2. **Auditing**: Review who did what and when
3. **Timeline**: Understand workflow progression
4. **Accountability**: Track agent activities

**No logs:**

If worktree has no log file, outputs: "No logs for \<name\>"

**Related commands:**

- `/worktree:who` - Check current lock owner
- `/worktree:annotate` - Add custom tracking metadata
- `/worktree` - List all worktrees

!"~/.claude/plugins/marketplaces/bengolea-plugins/orchestration/scripts/worktree/worktree" logs $ARGUMENTS
