# PreCompact

> Fires before conversation compaction begins.

## Basics

- **Fires when:** Claude Code is about to compress prior messages to stay within context limits
- **Can block:** No
- **Matcher:** N/A -- no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [{
          "type": "command",
          "command": "my-pre-compact-saver",
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

### Stdout / Exit codes

Output is ignored -- this is a notification-only hook.

## Patterns

### Save important context to files

Before compaction discards older messages, extract and persist any critical context (decisions, plans, partial results) to disk so it survives the compression.

```bash
#!/usr/bin/env bash
input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id')
echo "[$(date -Iseconds)] Pre-compact for session $session_id" \
  >> ~/.local/share/etch/compaction.log
```

### Snapshot conversation state

Capture a pre-compaction snapshot for debugging or auditing purposes.

```bash
#!/usr/bin/env bash
input=$(cat)
printf '%s' "$input" | jq -c '{event: "pre_compact", ts: now}' \
  >> ~/.local/share/etch/events/compaction.jsonl
```

## Edge Cases

- Compaction can happen multiple times in a long session. Hooks should be idempotent.
- Keep this hook fast -- it runs synchronously before compaction proceeds.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [PostCompact](post-compact.md) -- fires after compaction completes
