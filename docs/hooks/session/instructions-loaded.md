# InstructionsLoaded

> Fires when a CLAUDE.md or `.claude/rules/` file is loaded into context.

## Basics

- **Fires when:** Claude Code loads an instruction file (CLAUDE.md, AGENTS.md, or a rule from `.claude/rules/`)
- **Can block:** No
- **Matcher:** Instruction file path

### Minimal example

```jsonc
{
  "hooks": {
    "InstructionsLoaded": [
      {
        "matcher": "CLAUDE\\.md$",
        "hooks": [
          { "type": "command", "command": "echo loaded >> /tmp/instructions.log" }
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
| `file_path` | string | Absolute path of the loaded instruction file |

### Stdout / Exit codes

| Exit code | Behavior |
|-----------|----------|
| 0 | Success. Optional `additionalContext` in JSON stdout is injected. |
| 2 | Error logged but does not prevent the instruction from loading. |
| Other | Non-blocking warning. |

## Patterns

### Log instruction loading

Track which files are loaded and in what order — useful for debugging rule conflicts:

```bash
#!/usr/bin/env bash
input=$(cat)
file=$(echo "$input" | jq -r '.file_path // empty')
echo "[$(date -Iseconds)] Loaded: $file" >> /tmp/instructions-loaded.log
```

### Validate instruction format

Check that instruction files follow project conventions (e.g., required frontmatter in rules):

```bash
#!/usr/bin/env bash
input=$(cat)
file=$(echo "$input" | jq -r '.file_path // empty')

# Only validate rule files
[[ "$file" == *".claude/rules/"* ]] || exit 0

# Check for required paths: frontmatter
if ! head -5 "$file" | grep -q "^paths:"; then
  echo "Warning: $file missing paths: frontmatter" >&2
fi
```

## Edge Cases

- Fires for **each** instruction file individually, not once for all files.
- The matcher tests against the full file path, so you can target specific files or directories.
- Fires during session start and also when new instruction files are discovered mid-session.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [SessionStart](session-start.md) — fires before instructions are loaded
- [ConfigChange](../async-events/config-change.md) — fires when config files change (not instruction files)
