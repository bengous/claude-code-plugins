# SubagentStart

> Fires when a subagent (Agent tool call) is spawned.

## Basics

- **Fires when:** Claude invokes the Agent tool and a subagent process begins
- **Can block:** No
- **Matcher:** Agent type

### Minimal example

```jsonc
{
  "hooks": {
    "SubagentStart": [
      {
        "hooks": [{
          "type": "command",
          "command": "~/.local/bin/log-subagent-start",
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
| `session_id` | `string` | Parent session identifier |
| `cwd` | `string` | Working directory |
| `agent_id` | `string` | Unique identifier for this subagent |
| `agent_type` | `string` | Type of subagent being spawned |

### Stdout / Exit codes

This hook is observational — stdout is ignored. All exit codes are treated as informational.

## Patterns

### Track subagent count

Maintain a running count of subagents spawned per session:

```bash
#!/usr/bin/env bash
INPUT=$(cat /dev/stdin)
SESSION=$(echo "$INPUT" | jq -r '.session_id')
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id')

COUNT_FILE="/tmp/claude-subagents-${SESSION}"
echo "$AGENT_ID" >> "$COUNT_FILE"
echo "Subagent #$(wc -l < "$COUNT_FILE") started: $AGENT_ID" >&2
```

### Log subagent creation

```bash
#!/usr/bin/env bash
INPUT=$(cat /dev/stdin)
echo "$INPUT" | jq -c '{ts: now | todate, event: "start", agent_id, agent_type, session_id}' \
  >> /tmp/claude-subagents.jsonl
```

## Edge Cases

- Each subagent gets its own `agent_id` but shares the parent's `session_id`.
- This hook fires once per Agent tool invocation — if Claude spawns multiple subagents in sequence, each triggers its own SubagentStart.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [SubagentStop](subagent-stop.md) — fires when the subagent concludes
