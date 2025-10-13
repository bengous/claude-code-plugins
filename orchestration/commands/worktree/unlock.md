---
description: Release lock on worktree (validates ownership unless --force)
argument-hint: <name> [--agent ID] [--force]
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Release exclusive lock on a worktree with optional ownership validation. Safe for expired locks and supports forced unlocking for administrative cleanup.

**Common patterns:**

```bash
# Release your own lock
/worktree:unlock my-feature --agent me

# Force unlock (bypass ownership check)
/worktree:unlock stuck-work --force

# Clean up expired lock
/worktree:unlock old-feature --force
```

**Flags/Arguments:**

- `<name>` (required) - Worktree identifier
- `--agent <id>` - Agent identifier for ownership validation
- `--force` - Bypass ownership validation

**Behavior:**

- If no lock exists: Reports "No active lock" (not an error)
- If `--agent` provided: Validates current owner matches
- If `--force` provided: Bypasses all validation
- Removes lock file and logs unlock event

**Ownership validation:**

Without `--force`:
- If `--agent` specified and doesn't match owner → fails
- If `--agent` specified and matches owner → succeeds
- If no `--agent` specified → succeeds (no validation)

**Use cases:**

1. **Normal workflow**: Unlock after completing work
2. **Expired locks**: Use `--force` to clean up
3. **Administrative**: Use `--force` to resolve stuck locks
4. **Subagent handoff**: Unlock after subagent completes task

**Related commands:**

- `/worktree:lock` - Acquire exclusive lock
- `/worktree:who` - Check current lock owner
- `/worktree:transfer` - Transfer lock without unlock/relock cycle

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration`

**Your task:**

Execute the worktree management script:

```bash
<plugin-location-from-above>/scripts/worktree/worktree unlock $ARGUMENTS
```

Show the full output to the user.