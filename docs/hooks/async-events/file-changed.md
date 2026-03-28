# FileChanged

> Fires when a watched file changes on disk (external modification).

## Basics

- **Fires when:** A file that Claude Code is watching is modified externally (by the user, another process, or a build tool)
- **Can block:** No
- **Matcher:** File path -- matches against the changed file's path

### Minimal example

```jsonc
{
  "hooks": {
    "FileChanged": [
      {
        "matcher": "*.config.ts",
        "hooks": [{
          "type": "command",
          "command": "my-file-watcher",
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
| `file_path` | `string` | Absolute path of the changed file |

### Stdout / Exit codes

Output is ignored -- this is a notification-only hook.

## Patterns

### Auto-reload config on change

Invalidate caches or trigger rebuilds when configuration files are modified externally.

```bash
#!/usr/bin/env bash
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.file_path')
echo "[$(date -Iseconds)] File changed: $file" \
  >> ~/.local/share/etch/file-changes.log
```

### Trigger incremental rebuild

When source files change externally, trigger a targeted rebuild.

```bash
#!/usr/bin/env bash
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.file_path')
cwd=$(printf '%s' "$input" | jq -r '.cwd')
# Only rebuild if it's a source file
case "$file" in
  *.ts|*.tsx) cd "$cwd" && bun run build --filter="$(dirname "$file")" 2>&1 >&2 ;;
esac
```

## Edge Cases

- The matcher filters which file changes trigger the hook. Without a matcher, every watched file change fires it.
- High-frequency changes (e.g., from a build tool writing many files) may cause rapid repeated invocations. Keep the hook fast or debounce externally.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [ConfigChange](config-change.md) -- specifically for configuration file changes
- [CwdChanged](cwd-changed.md) -- fires when the working directory itself changes
