# PostCompact

> Fires after conversation compaction completes.

## Basics

- **Fires when:** Claude Code has finished compressing prior messages
- **Can block:** No
- **Matcher:** N/A -- no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "PostCompact": [
      {
        "hooks": [{
          "type": "command",
          "command": "my-post-compact-injector",
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

### Re-inject critical context

After compaction, essential context may have been lost. Write key information back to a file that Claude will re-read, or log the event for monitoring.

```bash
#!/usr/bin/env bash
input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id')
# Remind Claude of important constraints by writing to a context file
echo "Post-compact: context file still available at ./CONTEXT.md" >&2
```

### Update session metadata

Track compaction events to understand context pressure across sessions.

```bash
#!/usr/bin/env bash
input=$(cat)
printf '%s' "$input" | jq -c '{event: "post_compact", ts: now}' \
  >> ~/.local/share/etch/events/compaction.jsonl
```

## Edge Cases

- This hook fires after compaction is complete -- the conversation is already compressed.
- Multiple compactions per session are normal for long-running work.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide) — Re-inject context after compaction example
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [PreCompact](pre-compact.md) -- fires before compaction begins
