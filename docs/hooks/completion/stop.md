# Stop

> Fires right before Claude concludes its response -- can block to force more work.

## Basics

- **Fires when:** Claude is about to finish responding and end the turn
- **Can block:** Yes (return `{ "decision": "block", "reason": "..." }`)
- **Matcher:** N/A -- no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "my-stop-validator",
          "timeout": 30
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
| `stop_hook_active` | `boolean` | Anti-loop guard -- `true` on the second invocation after a block |
| `last_assistant_message` | `string` | The final assistant message from the turn |

### Stdout / Exit codes

Return JSON to stdout to block:

```json
{ "decision": "block", "reason": "Tests are failing -- fix them before stopping" }
```

Any other output (or no output) allows the stop to proceed.

| Exit code | Meaning |
|-----------|---------|
| `0` | Hook ran successfully (check stdout for block decision) |
| Non-zero | Hook failed -- stop proceeds, error logged |

## Patterns

### Scope-aware validation

Detect which files changed (backend vs frontend), run lint and format checks on the affected scope only, block if errors found.

```jsonc
{
  "hooks": [{
    "type": "command",
    "command": "cd $CLAUDE_PROJECT_DIR && bun scripts/validation/validate-on-stop.ts",
    "timeout": 60,
    "statusMessage": "Scope-aware validation..."
  }]
}
```

The validation script inspects `git diff --name-only`, partitions files by directory, and runs the relevant linter/formatter for each scope. Returns a block decision with the error output if any check fails.

### Session scoring and evaluation

Read the session transcript, score it on quality metrics (message length, git commits, plan mode usage, edit/write ratio, error loops), and spawn a fire-and-forget Claude evaluation fork if the score exceeds a threshold.

```jsonc
{
  "hooks": [{
    "type": "command",
    "command": "/home/user/.local/bin/etch-stop",
    "timeout": 30
  }]
}
```

The script reads session data from stdin, computes a composite score, and if the session is interesting enough, forks a background `claude` process to evaluate it and write structured events to the database.

### Remind about untracked plans

If commits were made during the session but plan files are not tracked in git, block the stop with a reminder to commit them.

```jsonc
{
  "hooks": [{
    "type": "command",
    "command": "/home/user/.local/bin/plan-stop-hook",
    "timeout": 30
  }]
}
```

Checks `git status --porcelain` for untracked `.plan` or `.md` files in plan directories. If found alongside new commits, returns a block decision.

## Edge Cases

- **Anti-loop guard:** When a Stop hook blocks, Claude tries to fix the issue and stop again. On the second attempt, `stop_hook_active` is `true` in the input. **You must check this flag** to avoid infinite block loops. A common pattern:
  ```bash
  if [ "$(echo "$input" | jq -r '.stop_hook_active')" = "true" ]; then
    exit 0  # Allow stop on second attempt
  fi
  ```
- **Multiple Stop hooks:** All registered Stop hooks run. If *any* of them blocks, Claude continues working.
- **Timeout:** If the hook exceeds its timeout, the stop proceeds (hook is killed).

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide) — Verify tests before stopping example
- [CI/CD Patterns with Hooks](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [StopFailure](stop-failure.md) -- fires on API errors instead of normal completion
- [SubagentStop](../agentic-loop/subagent-stop.md) -- the equivalent for subagent sessions
