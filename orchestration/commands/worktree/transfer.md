---
description: Transfer worktree lock ownership between agents
argument-hint: <name> --from A --to B
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Transfer lock ownership from one agent to another without unlock/relock cycle. Validates current ownership and preserves TTL and metadata.

**Common patterns:**

```bash
# Main agent transfers to subagent
/worktree:transfer my-feature --from me --to subagent1

# Subagent returns control to main agent
/worktree:transfer my-feature --from subagent1 --to me

# Transfer between subagents
/worktree:transfer api-work --from subagent1 --to subagent2
```

**Flags/Arguments:**

- `<name>` (required) - Worktree identifier
- `--from <id>` (required) - Current lock owner (must match)
- `--to <id>` (required) - New lock owner

**Behavior:**

- Validates lock exists (fails if no lock)
- Validates current owner matches `--from` (fails if mismatch)
- Updates lock owner to `--to`
- Updates `since` timestamp to current time
- Updates PID to current process
- Preserves TTL, reason, and expiration time
- Logs transfer event

**Why transfer instead of unlock/relock?**

1. **Atomic**: Single operation, no race conditions
2. **Preserves TTL**: Doesn't reset expiration timer
3. **Explicit**: Clear audit trail of ownership changes
4. **Validates**: Ensures only current owner can transfer

**Use cases:**

1. **Delegation handoff**: Main agent transfers to subagent
2. **Completion handoff**: Subagent returns to main agent
3. **Multi-agent workflows**: Sequential agent processing

**Related commands:**

- `/worktree:lock` - Acquire new lock
- `/worktree:unlock` - Release lock
- `/worktree:who` - Check current owner

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "/home/b3ngous/projects/claude-plugins/orchestration"`

**Your task:**

Execute the worktree management script:

```bash
<plugin-location-from-above>/scripts/worktree/worktree transfer $ARGUMENTS
```

Show the full output to the user.