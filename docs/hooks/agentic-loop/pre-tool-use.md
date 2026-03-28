# PreToolUse

> Fires before a tool executes — can allow, deny, or modify the tool call.

This is the most powerful hook in the system. It runs before every tool invocation and can make three decisions: allow the call silently (bypassing the permission dialog), deny it outright, or inject additional context for Claude to consider. Combined with matchers, it enables fine-grained policy enforcement over every action Claude takes.

## Basics

- **Fires when:** Claude is about to invoke a tool, before permission checks
- **Can block:** Yes — deny prevents the tool from executing; exit 2 also blocks
- **Matcher:** Tool name — matches against `Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `Agent`, `ExitPlanMode`, MCP tools as `mcp__<server>__<tool>`, and any other registered tool

### Minimal example

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "bun .claude/hooks/guard-destructive.ts",
          "timeout": 5,
          "statusMessage": "Checking for destructive commands..."
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
| `tool_name` | `string` | Name of the tool being invoked (e.g., `Bash`, `Edit`, `mcp__github__create_issue`) |
| `tool_input` | `object` | The tool's parameters — structure depends on the tool |

Common `tool_input` shapes:

| Tool | Key fields |
|------|-----------|
| `Bash` | `command`, `timeout`, `description` |
| `Edit` | `file_path`, `old_string`, `new_string` |
| `Write` | `file_path`, `content` |
| `Read` | `file_path`, `offset`, `limit` |
| `Glob` | `pattern`, `path` |
| `Grep` | `pattern`, `path`, `glob` |
| `Agent` | `prompt` |
| MCP tools | Varies by server and tool |

### Stdout (JSON)

Write a JSON object to stdout to communicate your decision:

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    // Required: the decision
    "permissionDecision": "allow",  // "allow" | "deny"
    // Optional: shown to the user and Claude when denying
    "permissionDecisionReason": "git push --force is not allowed on main",
    // Optional: injected into Claude's context (non-blocking)
    "additionalContext": "Reminder: this project uses worktrees for isolation"
  }
}
```

### Exit codes

| Exit code | Behavior |
|-----------|----------|
| `0` | Decision is read from stdout JSON |
| `0` (no stdout) | Tool call proceeds normally (implicit allow) |
| `2` | Tool call is denied (equivalent to `permissionDecision: "deny"`) |
| Other | Hook error — logged, tool call proceeds |

## Patterns

### Block destructive commands

Guard against `rm -rf`, `git push --force`, `git reset --hard`, and other irreversible operations. This is the most common PreToolUse pattern.

```jsonc
{
  "matcher": "Bash",
  "hooks": [{
    "type": "command",
    "command": "bun .claude/hooks/guard-destructive.ts",
    "timeout": 5,
    "statusMessage": "Checking for destructive commands..."
  }]
}
```

The script reads `tool_input.command` from stdin and checks against a blocklist:

```typescript
// .claude/hooks/guard-destructive.ts
const input = await Bun.stdin.json();
const cmd: string = input.tool_input?.command ?? "";

const BLOCKED = [
  /rm\s+(-rf|--recursive\s+--force)/,
  /git\s+push\s+--force/,
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-f/,
  />\s*\/dev\/sd/,
];

for (const pattern of BLOCKED) {
  if (pattern.test(cmd)) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Blocked destructive command: ${cmd}`,
      },
    }));
    process.exit(0);
  }
}
```

### Enforce worktree conventions

Intercept `git worktree add` commands and enforce that worktrees are created in the project's standard location:

```jsonc
{
  "matcher": "Bash",
  "hooks": [{
    "type": "command",
    "command": "~/.local/bin/git-worktree-hook"
  }]
}
```

The hook parses the command, checks if it matches `git worktree add`, and either allows it (if the path follows `../<repo>.wt/<name>/`) or denies with a message explaining the expected convention.

### Validate plan content before approval

Run validation when Claude exits plan mode, ensuring the plan meets quality standards before execution begins:

```jsonc
{
  "matcher": "ExitPlanMode",
  "hooks": [
    {
      "type": "command",
      "command": "~/.local/bin/validate-plan-target",
      "timeout": 10
    },
    {
      "type": "command",
      "command": "~/.local/bin/capture-pending-plan",
      "timeout": 10
    }
  ]
}
```

Multiple hooks on the same matcher run sequentially. Here, the first validates the plan's target scope and the second captures the plan content for archival before execution starts.

### Auto-approve safe tools in CI

In CI environments, auto-approve read-only tools to avoid blocking on permission dialogs:

```jsonc
{
  "matcher": "Read|Glob|Grep",
  "hooks": [{
    "type": "command",
    "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\"}}'",
    "timeout": 2
  }]
}
```

### Inject context for specific tools

Add reminders or constraints without blocking the tool:

```jsonc
{
  "matcher": "Edit",
  "hooks": [{
    "type": "command",
    "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"Remember: run oxfmt after editing TypeScript files\"}}'",
    "timeout": 2
  }]
}
```

## Edge Cases

- **Sequential execution:** Multiple PreToolUse hooks for the same matcher run sequentially. If any hook denies, the tool is blocked — later hooks do not run.
- **Deny feedback loop:** When a hook denies a tool call, the reason is shown to Claude, who may adjust the parameters and retry. Design deny reasons to be actionable (e.g., "use `git-wt` instead of `git worktree add`").
- **MCP tool names:** MCP tools appear as `mcp__<server>__<tool>` (e.g., `mcp__github__create_issue`). Use this full name in matchers.
- **Matcher syntax:** Matchers support `|` for alternation (e.g., `Edit|Write`). A hook with no matcher fires for all tools.
- **Timeout behavior:** If the hook times out, the tool call proceeds (fail-open). Set timeouts conservatively for blocking hooks.
- **No tool_response:** Unlike PostToolUse, this hook fires *before* execution — `tool_response` is not available.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide) — Block protected files example
- [CI/CD Patterns with Hooks](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [PostToolUse](post-tool-use.md) — fires after successful execution, can block to force corrections
- [PermissionRequest](permission-request.md) — fires when the permission dialog is about to show
- [PostToolUseFailure](post-tool-use-failure.md) — fires when a tool execution fails
