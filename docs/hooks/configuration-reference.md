# Configuration Reference

Complete reference for hook configuration in `settings.json`.

## Hook Configuration Schema

```jsonc
{
  "hooks": {
    "<EventName>": [              // One of the 26 event names
      {
        "matcher": "<pattern>",   // Optional: regex filter
        "if": "<condition>",      // Optional: conditional expression
        "hooks": [
          {
            "type": "command",    // "command" | "prompt" | "agent" | "http"
            "command": "...",     // Shell command (command type)
            "prompt": "...",      // Prompt text (prompt/agent type)
            "url": "...",         // URL (http type)
            "timeout": 10,        // Seconds (default varies by event)
            "statusMessage": "",  // UI status text while running
            "shell": "bash",     // Shell to use (default: user's shell)
            "async": false,       // Fire-and-forget (no blocking)
            "once": false         // Run only once per session
          }
        ]
      }
    ]
  }
}
```

## Hook Types

### Command

Runs a shell command. Receives JSON on stdin, communicates via stdout JSON + exit codes.

```jsonc
{
  "type": "command",
  "command": "bun .claude/hooks/my-hook.ts",
  "timeout": 10
}
```

### Prompt

Single-turn Claude evaluation. The prompt text is sent to Claude without tool access. Useful for lightweight validation or classification.

```jsonc
{
  "type": "prompt",
  "prompt": "Review this tool call for security issues. Output JSON with decision: 'allow' or 'deny'."
}
```

### Agent

Like prompt, but the evaluation has access to tools (Read, Grep, Bash, etc.). More powerful but slower and more expensive.

```jsonc
{
  "type": "agent",
  "prompt": "Verify that the edited file follows project conventions."
}
```

### HTTP

POSTs JSON to a URL. The request body contains the same JSON that stdin receives for command hooks.

```jsonc
{
  "type": "http",
  "url": "https://hooks.example.com/post-tool-use"
}
```

## Matcher Syntax

The `matcher` field is a **regex** tested against event-specific values:

| Event | Matcher tests against |
|-------|----------------------|
| PreToolUse | Tool name (e.g., `Bash`, `Edit`, `Write`, `Read`) |
| PostToolUse | Tool name |
| PostToolUseFailure | Tool name |
| PermissionRequest | Tool name |
| Notification | Notification type |
| SubagentStart | Agent type |
| SubagentStop | Agent type |
| ConfigChange | Config file path |
| InstructionsLoaded | Instruction file path |
| FileChanged | File path |

**Events without matcher support** (always fire): UserPromptSubmit, Stop, StopFailure, TeammateIdle, TaskCreated, TaskCompleted, SessionStart, SessionEnd, Setup, PreCompact, PostCompact, Elicitation, ElicitationResult, WorktreeCreate, WorktreeRemove, CwdChanged.

### Matcher examples

```jsonc
// Exact tool name
"matcher": "Bash"

// Multiple tools (pipe = regex alternation)
"matcher": "Edit|Write"

// MCP server tools
"matcher": "mcp__myserver__.*"

// Any tool starting with "mcp"
"matcher": "^mcp"
```

## The `if` Field

Conditional execution based on environment or context (available since v2.1.85):

```jsonc
{
  "matcher": "Bash",
  "if": "env.CI !== 'true'",
  "hooks": [...]
}
```

## Exit Code Semantics

| Exit code | Behavior |
|-----------|----------|
| **0** | Success. Stdout JSON is processed for decisions/context. No stdout = passthrough. |
| **2** | Blocking error. Action is prevented. Stderr shown to Claude as the reason. |
| **1, 3+** | Non-blocking error. Logged as warning. Action proceeds. |

## JSON Output Fields

Hooks communicate back via JSON on stdout. The shape depends on the event type.

### PreToolUse Output

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny",         // Control tool execution
    "permissionDecisionReason": "...",               // Shown to Claude on deny
    "additionalContext": "..."                        // Injected into Claude's context
  }
}
```

### PostToolUse Output

```jsonc
// Block pattern — Claude sees the reason and can fix the issue
{
  "decision": "block",
  "reason": "Lint errors found:\n  src/foo.ts:12 — no-unused-vars"
}

// Context injection — non-blocking, informational
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Effect Language Service: 2 warnings found"
  }
}
```

### Stop Output

```jsonc
// Block pattern — prevents Claude from finishing, shows reason
{
  "decision": "block",
  "reason": "Validation failed: 3 lint errors in src/"
}
```

### Generic Output (most events)

```jsonc
{
  "continue": true | false,           // Whether to continue (some events)
  "suppressOutput": true | false,     // Hide the hook's effect from Claude
  "systemMessage": "...",             // Shown to user in UI
  "hookSpecificOutput": {
    "additionalContext": "..."         // Injected into Claude's context
  }
}
```

## Standard Input (stdin)

Every hook receives JSON on stdin with at minimum:

```jsonc
{
  "session_id": "abc-123",
  "cwd": "/home/user/project",
  "tool_name": "Bash",              // Tool events only
  "tool_input": { ... },            // Tool events only — the tool's parameters
  "tool_response": { ... }          // PostToolUse only — the tool's result
}
```

The exact fields vary per event — see each hook's documentation page for the full schema.

## Environment Variables

| Variable | Available in | Description |
|----------|-------------|-------------|
| `CLAUDE_PROJECT_DIR` | All hooks | Absolute path to the project root |
| `CLAUDE_SESSION_ID` | All hooks | Current session identifier |
| `CLAUDE_PLUGIN_ROOT` | Plugin hooks | Root directory of the plugin |
| `CLAUDE_ENV_FILE` | All hooks | Path to write persistent env vars |
| `CLAUDE_CODE_REMOTE` | All hooks | `"true"` if running in remote/headless mode |

### Persistent Environment Variables

Write to `$CLAUDE_ENV_FILE` to set environment variables that persist across hook invocations within the session:

```bash
echo "MY_VAR=value" >> "$CLAUDE_ENV_FILE"
```

## Timeout Defaults

If no `timeout` is specified, hooks use a default that varies by event type. Most events default to **10 seconds**. Long-running hooks should set explicit timeouts. If a hook exceeds its timeout, it's killed and treated as a non-blocking error.

## Execution Model

- Multiple hooks in the same `hooks` array run **sequentially** (in order).
- Multiple hook groups for the same event (different matchers) run **in parallel**.
- Hooks run in the **same shell environment** as your terminal.
- Hook scripts should be **idempotent** — they may fire multiple times for the same logical action.

## Disabling Hooks

Pass `--no-hooks` to Claude Code to disable all hooks for a session:

```bash
claude --no-hooks
```

Or set in settings:

```jsonc
{
  "hooks": {
    "disabled": true
  }
}
```

## Resources

**Official documentation:**
- [Hooks Reference](https://code.claude.com/docs/en/hooks) — complete schemas, matchers, exit codes for all events
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide) — practical examples and getting started

**Community:**
- [claudefa.st — Complete Guide to Hooks](https://claudefa.st/blog/tools/hooks/hooks-guide) — lifecycle event walkthrough
- [Pixelmojo — CI/CD Patterns](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns) — production hook patterns
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/) — community examples and discussion
