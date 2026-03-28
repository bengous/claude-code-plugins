# TaskCreated

> Fires when a task is created via the TaskCreate tool.

## Basics

- **Fires when:** Claude creates a new task using the TaskCreate tool
- **Can block:** Yes — exit 2 rejects the task creation
- **Matcher:** N/A — no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "TaskCreated": [
      {
        "hooks": [{
          "type": "command",
          "command": "~/.local/bin/validate-task",
          "timeout": 5
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
| `task` | `object` | Task details (id, description, metadata) |

### Stdout / Exit codes

| Exit code | Behavior |
|-----------|----------|
| `0` | Task creation proceeds |
| `2` | Task creation is rejected |
| Other | Hook error — logged, task creation proceeds |

## Patterns

### Validate task naming

Ensure tasks follow a naming convention:

```bash
#!/usr/bin/env bash
INPUT=$(cat /dev/stdin)
DESC=$(echo "$INPUT" | jq -r '.task.description // ""')

if [ ${#DESC} -lt 10 ]; then
  echo "Task description too short — be specific" >&2
  exit 2
fi
```

### Enforce task limits

Prevent creating too many concurrent tasks:

```bash
#!/usr/bin/env bash
INPUT=$(cat /dev/stdin)
SESSION=$(echo "$INPUT" | jq -r '.session_id')
COUNT_FILE="/tmp/claude-tasks-${SESSION}"

COUNT=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
if [ "$COUNT" -gt 10 ]; then
  echo "Too many tasks ($COUNT). Complete existing tasks first." >&2
  exit 2
fi
echo "$COUNT" > "$COUNT_FILE"
```

### Log task creation

```bash
#!/usr/bin/env bash
INPUT=$(cat /dev/stdin)
echo "$INPUT" | jq -c '{ts: now | todate, event: "created", task}' >> /tmp/claude-tasks.jsonl
```

## Edge Cases

- This hook fires only for tasks created via the TaskCreate tool, not for implicit task tracking.
- Blocking task creation tells Claude the task was rejected — it receives the stderr output as context.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [TaskCompleted](task-completed.md) — fires when a task is marked as completed
