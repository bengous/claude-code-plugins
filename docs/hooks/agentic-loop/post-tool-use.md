# PostToolUse

> Fires after a tool executes successfully — can block to force corrections or inject context into Claude's reasoning.

## Basics

- **Fires when:** A tool has executed and returned a successful result
- **Can block:** Yes — `decision: "block"` with a reason tells Claude the result is unacceptable and it must fix the issue
- **Matcher:** Tool name

### Minimal example

```jsonc
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [{
          "type": "command",
          "command": "bun scripts/validation/format-and-lint.ts",
          "timeout": 30,
          "statusMessage": "Formatting and linting..."
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
| `cwd` | `string` | Working directory of the session |
| `tool_name` | `string` | Name of the tool that executed |
| `tool_input` | `object` | The tool's parameters (same as what PreToolUse received) |
| `tool_response` | `object` | The tool's output — structure depends on the tool |

Common `tool_response` shapes:

| Tool | Key fields |
|------|-----------|
| `Bash` | `stdout`, `stderr`, `exitCode` |
| `Edit` | `success`, `file_path` |
| `Write` | `success`, `file_path` |
| `Read` | `content`, `file_path` |

### Stdout (JSON)

Two output patterns are available:

**Block pattern** — tells Claude the result is unacceptable and provides the reason:

```jsonc
{
  "decision": "block",
  "reason": "Lint errors found:\nsrc/foo.ts:12 - no-unused-vars"
}
```

**Context injection** — adds information to Claude's context without blocking:

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Effect Language Service: 2 warnings in src/services/timer.ts"
  }
}
```

These can be combined — block with a reason while also injecting context.

### Exit codes

| Exit code | Behavior |
|-----------|----------|
| `0` | Decision is read from stdout JSON |
| `0` (no stdout) | Tool result proceeds to Claude unchanged |
| `2` | Tool result is blocked (equivalent to `decision: "block"`) |
| Other | Hook error — logged, tool result proceeds |

## Patterns

### Auto-format and lint after edits

Run formatting and linting on every file that Claude edits or writes. Block if there are errors so Claude can fix them; inject warnings as non-blocking context.

```jsonc
{
  "matcher": "Edit|Write",
  "hooks": [{
    "type": "command",
    "command": "bun scripts/validation/format-and-lint.ts",
    "timeout": 30,
    "statusMessage": "Formatting and linting..."
  }]
}
```

The script:

```typescript
// scripts/validation/format-and-lint.ts
const input = await Bun.stdin.json();
const filePath: string = input.tool_input?.file_path;

if (!filePath?.endsWith(".ts")) process.exit(0);

// Run oxfmt (auto-format, never blocks)
await Bun.$`oxfmt --write ${filePath}`.quiet();

// Run oxlint (blocks on errors)
const lint = await Bun.$`oxlint ${filePath}`.quiet().nothrow();

if (lint.exitCode !== 0) {
  console.log(JSON.stringify({
    decision: "block",
    reason: `Lint errors in ${filePath}:\n${lint.stdout.toString()}`,
  }));
} else {
  // Optionally inject Effect Language Service diagnostics as context
  const diagnostics = await getEffectDiagnostics(filePath);
  if (diagnostics) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: diagnostics,
      },
    }));
  }
}
```

### Track git commits

Detect successful `git commit` commands in Bash tool output and maintain a session counter:

```jsonc
{
  "matcher": "Bash",
  "hooks": [{
    "type": "command",
    "command": "~/.local/bin/commit-counter",
    "timeout": 10
  }]
}
```

The script checks `tool_input.command` for `git commit` and `tool_response.exitCode` for success, then increments a counter in a session-scoped file.

### Archive approved plans

After Claude exits plan mode, archive the plan content for reference:

```jsonc
{
  "matcher": "ExitPlanMode",
  "hooks": [{
    "type": "command",
    "command": "~/.local/bin/archive-plan",
    "timeout": 10
  }]
}
```

### Validate test results

After Bash commands that look like test runs, check for failures:

```bash
#!/usr/bin/env bash
# check-test-results.sh
INPUT=$(cat /dev/stdin)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exitCode // 0')

if echo "$CMD" | grep -qE '(bun test|vitest|jest)' && [ "$EXIT_CODE" != "0" ]; then
  STDERR=$(echo "$INPUT" | jq -r '.tool_response.stderr // ""')
  cat <<EOF
{
  "decision": "block",
  "reason": "Tests failed. Fix before proceeding:\n$STDERR"
}
EOF
fi
```

## Edge Cases

- `tool_response` contains the full tool output. For Bash, this includes `stdout`, `stderr`, and `exitCode`.
- Blocking a PostToolUse does not undo the tool's side effects — the file is already written, the command already ran. The block tells Claude the result is unacceptable and it should take corrective action.
- Multiple PostToolUse hooks for the same matcher run sequentially. If any blocks, Claude receives the block reason.
- The `decision: "block"` and `hookSpecificOutput.additionalContext` patterns serve different purposes: blocking forces Claude to act, while context injection is advisory.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide) — Auto-format with Prettier example
- [CI/CD Patterns with Hooks](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [PreToolUse](pre-tool-use.md) — fires before execution, can prevent the tool from running
- [PostToolUseFailure](post-tool-use-failure.md) — fires when the tool itself fails (not when the hook blocks)
