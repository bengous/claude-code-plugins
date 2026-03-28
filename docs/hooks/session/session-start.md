# SessionStart

> Fires when a new session begins, resumes, or restarts after `/clear` or `/compact`.

## Basics

- **Fires when:** A Claude Code session starts, resumes, or is reset
- **Can block:** No
- **Matcher:** N/A -- no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "echo 'session started'",
        "timeout": 5
      }
    ]
  }
}
```

## Input / Output

### Stdin (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Unique identifier for the session |
| `cwd` | `string` | Working directory of the session |

### Stdout / Exit codes

| Exit code | Behavior |
|-----------|----------|
| `0` | Success. If stdout contains JSON with `hookSpecificOutput.additionalContext`, that string is injected into the session context. |
| `2` | Error message shown to the user but does not block the session. |
| Other | Treated as failure; error logged. |

#### Injecting context

Write JSON to stdout to add context visible to the model:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Current sprint: auth-v2. Focus areas: login flow, MFA."
  }
}
```

## Patterns

### Archive previous session data

Run a script that archives the prior session's artifacts before the new one begins.

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "bun ~/projects/claude-plugins/session-archive/session-archive.ts --hook",
        "timeout": 10
      }
    ]
  }
}
```

### Finalize orphan markers

Clean up pending-plan markers left behind by a previous session that exited without completing.

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "bun ~/projects/etch/src/hooks/finalize-orphan-plans.ts",
        "timeout": 5
      }
    ]
  }
}
```

### Initialize session metadata

Write a metadata file that other hooks or tools can reference during the session.

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "echo '{\"started\":\"'$(date -Iseconds)'\"}' > /tmp/claude-session-meta.json",
        "timeout": 5
      }
    ]
  }
}
```

## Edge Cases

- **Fires on resume, not just fresh sessions.** If the user resumes a session or hits `/clear` or `/compact`, SessionStart fires again. Make hooks idempotent -- don't assume a clean slate.
- **No guaranteed pairing with SessionEnd.** A session may be killed before SessionEnd fires. Don't use SessionStart to acquire resources that require explicit release.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [CI/CD Patterns with Hooks](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [SessionEnd](session-end.md) -- fires when the session terminates
- [InstructionsLoaded](instructions-loaded.md) -- fires when CLAUDE.md or rules files load
