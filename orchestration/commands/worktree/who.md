---
description: Show current lock owner and expiration details
argument-hint: <name>
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree":who)
model: claude-sonnet-4-5
---

Display current lock ownership details including agent, TTL, reason, state (active/expired), and expiration timestamp.

**Common patterns:**

```bash
# Check if worktree is locked
/worktree:who my-feature

# Verify lock before attempting unlock
/worktree:who api-work
/worktree:unlock api-work --agent subagent1

# Check expiration before requesting transfer
/worktree:who long-running-task
```

**Example output (active lock):**

```json
{
  "agent": "me",
  "since": "2025-10-06T14:30:00Z",
  "ttl": "6h",
  "reason": "Implementing authentication",
  "pid": 12345,
  "expires_at": "2025-10-06T20:30:00Z",
  "state": "active"
}
```

**Example output (expired lock):**

```json
{
  "agent": "subagent1",
  "since": "2025-10-05T10:00:00Z",
  "ttl": "6h",
  "pid": 54321,
  "expires_at": "2025-10-05T16:00:00Z",
  "state": "expired"
}
```

**Example output (no lock):**

```
Worktree my-feature is not locked
```

**Output fields:**

- `agent` - Agent identifier who holds the lock
- `since` - When lock was acquired (ISO 8601)
- `ttl` - Original time-to-live specification
- `reason` - Optional explanation (if provided)
- `pid` - Process ID that created the lock
- `expires_at` - Expiration timestamp (ISO 8601)
- `state` - Lock state: `active` or `expired`

**Related commands:**

- `/worktree:lock` - Acquire exclusive lock
- `/worktree:unlock` - Release lock ownership
- `/worktree` - List all worktrees with lock status

**Your task:**

Execute the script to perform the who operation:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree" who $ARGUMENTS
```

The script is already permitted via allowed-tools. Run it and report the results.