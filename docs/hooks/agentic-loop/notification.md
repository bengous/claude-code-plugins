# Notification

> Fires when Claude Code sends a desktop or system notification.

## Basics

- **Fires when:** Claude Code dispatches a notification (e.g., task complete, waiting for input)
- **Can block:** No
- **Matcher:** Notification type

### Minimal example

```jsonc
{
  "hooks": {
    "Notification": [
      {
        "hooks": [{
          "type": "command",
          "command": "~/.local/bin/notify-slack",
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
| `message` | `string` | Notification content |
| `type` | `string` | Notification type |

### Stdout / Exit codes

This hook is observational — stdout is ignored. All exit codes are treated as informational.

## Patterns

### Custom notification routing

Forward notifications to Slack, Discord, or any webhook:

```bash
#!/usr/bin/env bash
# notify-slack.sh
INPUT=$(cat /dev/stdin)
MESSAGE=$(echo "$INPUT" | jq -r '.message // "Claude Code notification"')

curl -s -X POST "$SLACK_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d "{\"text\": \"$MESSAGE\"}" > /dev/null
```

### Log notifications

```bash
#!/usr/bin/env bash
INPUT=$(cat /dev/stdin)
echo "$INPUT" | jq -c '{ts: now | todate, message, type}' >> /tmp/claude-notifications.jsonl
```

## Edge Cases

- Notifications typically fire when Claude finishes a long-running task or needs user attention.
- This hook cannot suppress or modify the notification — it is purely observational.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide) — Desktop notifications example
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [Stop](../completion/stop.md) — fires when the session ends, often triggering the final notification
