# StopFailure

> Fires when a turn ends due to an API error.

## Basics

- **Fires when:** The current turn terminates because of an API error (network failure, rate limit, server error)
- **Can block:** No
- **Matcher:** N/A -- no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "StopFailure": [
      {
        "hooks": [{
          "type": "command",
          "command": "my-error-logger",
          "timeout": 10
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
| `error` | `object` | Error details (type, message, status code if applicable) |

### Stdout / Exit codes

Output is ignored -- this hook cannot influence the outcome.

## Patterns

### Error logging and alerting

Log API errors to a file or send a notification so you can track reliability issues.

```bash
#!/usr/bin/env bash
input=$(cat)
error_type=$(printf '%s' "$input" | jq -r '.error.type // "unknown"')
echo "[$(date -Iseconds)] StopFailure: $error_type" >> ~/.local/share/etch/api-errors.log
```

### Session state preservation

Save in-progress work context before the session terminates unexpectedly.

```bash
#!/usr/bin/env bash
input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id')
# Dump session metadata for later recovery
printf '%s' "$input" > "/tmp/claude-recovery-${session_id}.json"
```

## Edge Cases

- This hook fires on API-level failures only, not on user cancellation or normal completion.
- The hook should be fast -- the session is already ending and the user is waiting.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [Stop](stop.md) -- fires on normal completion (can block)
