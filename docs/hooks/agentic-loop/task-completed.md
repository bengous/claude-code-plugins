# TaskCompleted

> Fires when a task is marked as completed.

## Basics

- **Fires when:** A task transitions to a completed state
- **Can block:** Yes — exit 2 rejects the completion, keeping the task open
- **Matcher:** N/A — no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "TaskCompleted": [
      {
        "hooks": [{
          "type": "command",
          "command": "~/.local/bin/verify-task",
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
| `task` | `object` | Task details (id, description, metadata, result) |

### Stdout / Exit codes

| Exit code | Behavior |
|-----------|----------|
| `0` | Task completion proceeds |
| `2` | Completion is rejected — task remains open |
| Other | Hook error — logged, completion proceeds |

## Patterns

### Run verification on completed tasks

Ensure tests pass or acceptance criteria are met before allowing a task to close:

```bash
#!/usr/bin/env bash
INPUT=$(cat /dev/stdin)
TASK_DESC=$(echo "$INPUT" | jq -r '.task.description // ""')

# Run tests if the task mentions code changes
if echo "$TASK_DESC" | grep -qiE '(implement|fix|refactor|add)'; then
  if ! bun test --bail 2>/dev/null; then
    echo "Tests failing — task cannot be completed until tests pass" >&2
    exit 2
  fi
fi
```

### Update external trackers

Sync task completion to an external project management tool:

```bash
#!/usr/bin/env bash
INPUT=$(cat /dev/stdin)
TASK_ID=$(echo "$INPUT" | jq -r '.task.id')
curl -s -X POST "https://api.tracker.example/tasks/$TASK_ID/complete" \
  -H "Authorization: Bearer $TRACKER_TOKEN" > /dev/null
```

### Log task completion

```bash
#!/usr/bin/env bash
INPUT=$(cat /dev/stdin)
echo "$INPUT" | jq -c '{ts: now | todate, event: "completed", task}' >> /tmp/claude-tasks.jsonl
```

## Edge Cases

- Blocking completion tells Claude the task is not actually done and provides the reason. Claude will continue working on it.
- The `task` object in the input includes the task's result or output at the time of completion.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [TaskCreated](task-created.md) — fires when a task is first created
