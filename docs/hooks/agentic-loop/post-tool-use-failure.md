# PostToolUseFailure

> Fires after a tool execution fails — the tool itself errored, not a hook denial.

## Basics

- **Fires when:** A tool invocation results in an error (e.g., file not found, command crashed, MCP tool returned an error)
- **Can block:** No
- **Matcher:** Tool name

### Minimal example

```jsonc
{
  "hooks": {
    "PostToolUseFailure": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "~/.local/bin/log-tool-failure",
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
| `cwd` | `string` | Working directory of the session |
| `tool_name` | `string` | Name of the tool that failed |
| `tool_input` | `object` | The tool's parameters |
| `error` | `string` | Error message or details from the failure |

### Stdout / Exit codes

This hook is observational — stdout is ignored. All exit codes are treated as informational.

| Exit code | Behavior |
|-----------|----------|
| Any | Logged; does not affect the agent loop |

## Patterns

### Log failures for debugging

Append tool failures to a log file for post-session analysis:

```bash
#!/usr/bin/env bash
# log-tool-failure.sh
INPUT=$(cat /dev/stdin)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')
ERROR=$(echo "$INPUT" | jq -r '.error // "unknown"')
echo "[$(date -Iseconds)] FAIL $TOOL: $ERROR" >> /tmp/claude-tool-failures.log
```

### Alert on repeated failures

Track failure counts and send an alert if a tool fails repeatedly in the same session:

```bash
#!/usr/bin/env bash
# failure-alert.sh
INPUT=$(cat /dev/stdin)
SESSION=$(echo "$INPUT" | jq -r '.session_id')
TOOL=$(echo "$INPUT" | jq -r '.tool_name')

COUNT_FILE="/tmp/claude-failures-${SESSION}-${TOOL}"
COUNT=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$COUNT" > "$COUNT_FILE"

if [ "$COUNT" -ge 3 ]; then
  # Send webhook, write to stderr for visibility, etc.
  echo "Tool $TOOL has failed $COUNT times in session $SESSION" >&2
fi
```

## Edge Cases

- This hook fires for tool-level failures, not hook denials. If PreToolUse denies a tool, PostToolUseFailure does not fire.
- Claude already sees the error and will typically adjust its approach — this hook is purely for observability.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [PostToolUse](post-tool-use.md) — fires on successful execution
- [PreToolUse](pre-tool-use.md) — fires before execution, can prevent failures by blocking dangerous calls
