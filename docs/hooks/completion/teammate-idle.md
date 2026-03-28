# TeammateIdle

> Fires when a teammate agent is about to go idle.

## Basics

- **Fires when:** A teammate agent has finished its current work and is about to become idle
- **Can block:** Yes
- **Matcher:** N/A -- no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "TeammateIdle": [
      {
        "hooks": [{
          "type": "command",
          "command": "my-teammate-dispatcher",
          "timeout": 15
        }]
      }
    ]
  }
}
```

## Input / Output

### Stdin (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Current session identifier |
| `cwd` | `string` | Working directory |
| `teammate` | `object` | Teammate agent information (id, name, status) |

### Stdout / Exit codes

Return a block decision to prevent the teammate from going idle (e.g., assign it more work).

| Exit code | Meaning |
|-----------|---------|
| `0` | Hook ran successfully |
| Non-zero | Hook failed -- teammate proceeds to idle |

## Patterns

### Work queue dispatch

Check a task queue and assign pending work to the idle teammate.

```bash
#!/usr/bin/env bash
input=$(cat)
teammate_id=$(printf '%s' "$input" | jq -r '.teammate.id')
# Check for pending tasks and assign to the idle teammate
pending=$(check-task-queue --format json)
if [ -n "$pending" ]; then
  printf '{"decision":"block","reason":"Assigning pending task"}'
fi
```

### Idle event logging

Track teammate utilization by logging idle events.

```bash
#!/usr/bin/env bash
input=$(cat)
printf '%s' "$input" | jq -c '{event: "teammate_idle", ts: now}' >> ~/.local/share/etch/teammate-events.jsonl
```

## Edge Cases

- Blocking an idle teammate means Claude will try to give it more work. Avoid blocking indefinitely if no work is available.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [SubagentStop](../agentic-loop/subagent-stop.md) -- fires when a subagent session ends
- [TaskCompleted](../agentic-loop/task-completed.md) -- fires when a delegated task completes
