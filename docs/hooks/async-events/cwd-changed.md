# CwdChanged

> Fires after the working directory changes.

## Basics

- **Fires when:** Claude Code's working directory changes during a session
- **Can block:** No
- **Matcher:** N/A -- no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "CwdChanged": [
      {
        "hooks": [{
          "type": "command",
          "command": "my-cwd-handler",
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
| `old_cwd` | `string` | Previous working directory |
| `new_cwd` | `string` | New working directory |

### Stdout / Exit codes

Output is ignored -- this is a notification-only hook.

## Patterns

### Load environment configuration

Trigger direnv or similar tools when switching project directories.

```bash
#!/usr/bin/env bash
input=$(cat)
new_cwd=$(printf '%s' "$input" | jq -r '.new_cwd')
# Export direnv environment for the new directory
if [ -f "${new_cwd}/.envrc" ]; then
  direnv allow "${new_cwd}" 2>/dev/null || true
fi
```

### Update project context

Switch tool configurations or reload project-specific settings when the directory changes.

```bash
#!/usr/bin/env bash
input=$(cat)
new_cwd=$(printf '%s' "$input" | jq -r '.new_cwd')
old_cwd=$(printf '%s' "$input" | jq -r '.old_cwd')
printf '{"event":"cwd_changed","from":"%s","to":"%s","ts":%d}\n' \
  "$old_cwd" "$new_cwd" "$(date +%s)" \
  >> ~/.local/share/etch/events/navigation.jsonl
```

## Edge Cases

- May fire multiple times in rapid succession if Claude navigates through several directories.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide) — Reload direnv on directory change example
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [ConfigChange](config-change.md) -- fires when configuration files change
- [FileChanged](file-changed.md) -- fires when watched files change on disk
