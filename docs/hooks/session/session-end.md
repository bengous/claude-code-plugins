# SessionEnd

> Fires when a session is terminating.

## Basics

- **Fires when:** The Claude Code session is ending (user exits, session timeout, or explicit termination)
- **Can block:** No
- **Matcher:** N/A — no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "echo session-end >> /tmp/claude-sessions.log" }
        ]
      }
    ]
  }
}
```

## Input / Output

### Stdin (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Current session identifier |
| `cwd` | string | Working directory |

### Stdout / Exit codes

| Exit code | Behavior |
|-----------|----------|
| 0 | Success. |
| Other | Logged but cannot prevent session end. |

This hook is purely observational — it cannot prevent the session from ending.

## Patterns

### Flush session logs

Write final session metadata before exit:

```bash
#!/usr/bin/env bash
input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // empty')
echo "{\"event\":\"session_end\",\"session\":\"$session_id\",\"ts\":\"$(date -Iseconds)\"}" \
  >> ~/.local/share/my-tool/sessions.jsonl
```

### Cleanup temporary files

```bash
#!/usr/bin/env bash
input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd // empty')
rm -f "$cwd/.claude/tmp/"* 2>/dev/null || true
```

### Send analytics

```bash
#!/usr/bin/env bash
input=$(cat)
# Fire-and-forget POST to analytics endpoint
curl -sf -X POST https://analytics.internal/session-end \
  -H "Content-Type: application/json" \
  -d "$input" &>/dev/null || true
```

## Edge Cases

- **Not guaranteed to fire** if the process is killed with SIGKILL or if the system crashes. Don't rely on it for critical cleanup — use defense-in-depth (e.g., SessionStart cleans up stale data from previous sessions).
- Runs with a tight timeout — keep cleanup fast or make it async.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [CI/CD Patterns with Hooks](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [SessionStart](session-start.md) — the counterpart at session beginning
- [Stop](../completion/stop.md) — fires before Claude finishes responding (not session end)
