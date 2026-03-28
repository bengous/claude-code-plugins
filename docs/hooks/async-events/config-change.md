# ConfigChange

> Fires when a configuration file changes during a session.

## Basics

- **Fires when:** A configuration file (settings, CLAUDE.md, etc.) is modified during a session
- **Can block:** Yes
- **Matcher:** Config file path -- matches against the changed config file's path

### Minimal example

```jsonc
{
  "hooks": {
    "ConfigChange": [
      {
        "matcher": "settings.json",
        "hooks": [{
          "type": "command",
          "command": "my-config-validator",
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
| `config_path` | `string` | Absolute path of the changed configuration file |

### Stdout / Exit codes

Return a block decision to reject the configuration change.

| Exit code | Meaning |
|-----------|---------|
| `0` | Hook ran successfully (check stdout for block decision) |
| Non-zero | Hook failed -- config change proceeds |

## Patterns

### Validate config changes

Check that configuration changes are valid before they take effect.

```bash
#!/usr/bin/env bash
input=$(cat)
config=$(printf '%s' "$input" | jq -r '.config_path')
# Validate JSON syntax
if ! jq empty "$config" 2>/dev/null; then
  printf '{"decision":"block","reason":"Invalid JSON in %s"}' "$config"
fi
```

### Audit config modifications

Log all configuration changes for security auditing.

```bash
#!/usr/bin/env bash
input=$(cat)
printf '%s' "$input" | jq -c '{event: "config_change", ts: now, path: .config_path}' \
  >> ~/.local/share/etch/config-audit.jsonl
```

## Edge Cases

- Blocking a config change prevents it from taking effect in the current session.
- The matcher lets you target specific config files rather than reacting to every change.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide) — Audit configuration changes example
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [FileChanged](file-changed.md) -- general-purpose file change detection
- [InstructionsLoaded](../session/instructions-loaded.md) -- fires when CLAUDE.md or rules are loaded
