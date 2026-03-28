# Getting Started with Hooks

Hooks are shell commands (or prompts) that Claude Code runs automatically at specific lifecycle points. They let you enforce project standards, automate workflows, and extend Claude Code's behavior — without modifying Claude Code itself.

Hooks receive structured JSON on **stdin** describing the current context (tool name, file path, session ID, etc.) and communicate back through **stdout** (JSON) and **exit codes**. They run in the same environment as your terminal, so they have access to your tools, files, and environment variables.

## Where to Configure

Hooks live in `settings.json` files at three scopes (merged at runtime, most specific wins):

| Scope | File | Applies to |
|-------|------|-----------|
| **Global** | `~/.claude/settings.json` | All projects |
| **Project** | `<project>/.claude/settings.json` | This project (committed to git) |
| **Local** | `<project>/.claude/settings.local.json` | This project (gitignored) |

Plugins can also register hooks via their `hooks.json`.

## Anatomy of a Hook

```jsonc
// In settings.json
{
  "hooks": {
    "PreToolUse": [           // Event name — when to fire
      {
        "matcher": "Bash",    // Optional: only fire for matching tools
        "hooks": [            // Array of hooks to run (in order)
          {
            "type": "command",
            "command": "bun .claude/hooks/guard-destructive.ts",
            "timeout": 5,
            "statusMessage": "Checking for destructive commands..."
          }
        ]
      }
    ]
  }
}
```

**Key fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | `"command"` (shell), `"prompt"` (single-turn Claude eval), or `"agent"` (subagent with tools) |
| `command` | Yes (command) | Shell command to run. Receives JSON on stdin. |
| `timeout` | No | Seconds before the hook is killed (default varies by event) |
| `matcher` | No | Regex to filter when the hook fires (what it matches depends on the event) |
| `statusMessage` | No | Message shown in the UI while the hook runs |
| `if` | No | Conditional expression — hook only runs when true |
| `once` | No | If `true`, runs only once per session |

## Your First Hook: Block Destructive Commands

Let's build a `PreToolUse` hook that blocks `rm -rf` and similar commands before they execute.

### 1. Create the hook script

```typescript
// .claude/hooks/guard-destructive.ts
const input = await Bun.stdin.text();
const parsed = JSON.parse(input);
const cmd = parsed.tool_input?.command ?? "";

const BLOCKED = [
  /rm\s+-rf\b/,
  /git\s+push\s+--force(?!-)/,
  /git\s+reset\s+--hard\b/,
];

const match = BLOCKED.find((re) => re.test(cmd));

if (match) {
  // Exit 0 + JSON with deny decision = block the tool
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Blocked: ${cmd}`,
    },
  }));
}

// Exit 0 with no output = allow the tool
```

### 2. Register it in settings.json

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bun .claude/hooks/guard-destructive.ts",
            "timeout": 5,
            "statusMessage": "Checking for destructive commands..."
          }
        ]
      }
    ]
  }
}
```

### 3. Test it

Ask Claude to run `rm -rf /tmp/test`. The hook will intercept the `Bash` tool call, read the command from stdin, match against the blocked patterns, and output a deny decision. Claude sees the reason and stops.

## Exit Codes

| Exit code | Meaning |
|-----------|---------|
| **0** | Success. If stdout contains JSON, it's processed (decisions, context injection, etc.) |
| **2** | **Blocking error.** The action is prevented. Stderr is shown to Claude as the reason. |
| **Other** | Non-blocking error. Logged but doesn't prevent the action. |

## Environment Variables

These are always available inside hook commands:

| Variable | Description |
|----------|-------------|
| `CLAUDE_PROJECT_DIR` | Absolute path to the project root |
| `CLAUDE_SESSION_ID` | Current session identifier |
| `CLAUDE_PLUGIN_ROOT` | Root of the plugin that registered this hook (plugins only) |

## Next Steps

- [Configuration Reference](configuration-reference.md) — full schema, matcher syntax, JSON output fields
- [PreToolUse](agentic-loop/pre-tool-use.md) — the most commonly used hook event
- [Stop](completion/stop.md) — run validation before Claude finishes
- [SessionStart](session/session-start.md) — initialize state when a session begins

## Resources

**Official documentation:**
- [Hooks Reference](https://code.claude.com/docs/en/hooks) — complete schemas, matchers, exit codes for all events
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide) — practical examples and getting started

**Community:**
- [claudefa.st — Complete Guide to Hooks](https://claudefa.st/blog/tools/hooks/hooks-guide) — lifecycle event walkthrough
- [Pixelmojo — CI/CD Patterns](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns) — production hook patterns
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/) — community examples and discussion
