# Setup

> Fires during repo setup for initialization and maintenance tasks.

## Basics

- **Fires when:** Claude Code runs repo initialization or maintenance routines
- **Can block:** No
- **Matcher:** N/A — no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "Setup": [
      {
        "hooks": [
          { "type": "command", "command": "bun install --silent", "timeout": 30 }
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
| 2 | Error logged but does not block setup. |
| Other | Non-blocking warning. |

## Patterns

### Install dependencies

Ensure dependencies are up to date when entering a project:

```jsonc
{
  "hooks": [
    { "type": "command", "command": "bun install --frozen-lockfile --silent", "timeout": 60 }
  ]
}
```

### Run database migrations

```jsonc
{
  "hooks": [
    { "type": "command", "command": "bun run db:migrate", "timeout": 30 }
  ]
}
```

### Initialize git hooks

```jsonc
{
  "hooks": [
    { "type": "command", "command": "lefthook install", "timeout": 10 }
  ]
}
```

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [SessionStart](session-start.md) — fires when the session begins (Setup fires during repo initialization)
- [InstructionsLoaded](instructions-loaded.md) — fires when instruction files are loaded
