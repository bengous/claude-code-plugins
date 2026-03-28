# Claude Code Hooks

Hooks let you run custom code at specific points in Claude Code's lifecycle — before a tool executes, after a session starts, when context is compacted, and more. They're configured in `settings.json` and receive structured JSON on stdin.

**New to hooks?** Start with the [Getting Started](getting-started.md) guide.
**Need the full schema?** See the [Configuration Reference](configuration-reference.md).

## Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│ SESSION                                                      │
│                                                              │
│ SessionStart → InstructionsLoaded → Setup                    │
│      │                                                       │
│      ▼                                                       │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ AGENTIC LOOP                                             │ │
│ │                                                          │ │
│ │ UserPromptSubmit                                         │ │
│ │      │                                                   │ │
│ │      ▼                                                   │ │
│ │ PreToolUse → PermissionRequest → PostToolUse             │ │
│ │      │                              │                    │ │
│ │      │                        PostToolUseFailure         │ │
│ │                                                          │ │
│ │ SubagentStart ──► SubagentStop                           │ │
│ │ TaskCreated ────► TaskCompleted                          │ │
│ │ Notification                                             │ │
│ └─────────────────────────┬────────────────────────────────┘ │
│                           │                                  │
│                           ▼                                  │
│ ┌────────────────────────────────────────┐                   │
│ │ COMPLETION                             │                   │
│ │ Stop · StopFailure · TeammateIdle      │                   │
│ └────────────────────────────────────────┘                   │
│                                                              │
│ ┌──────────────────┐ ┌─────────────────────────────────────┐ │
│ │ CONTEXT          │ │ ASYNC EVENTS                        │ │
│ │ PreCompact       │ │ WorktreeCreate · WorktreeRemove     │ │
│ │ PostCompact      │ │ CwdChanged · FileChanged            │ │
│ └──────────────────┘ │ ConfigChange                        │ │
│                      └─────────────────────────────────────┘ │
│ ┌──────────────────┐                                         │
│ │ MCP              │                                         │
│ │ Elicitation      │          SessionEnd                     │
│ │ ElicitationResult│                                         │
│ └──────────────────┘                                         │
└──────────────────────────────────────────────────────────────┘
```

## Quick Reference

| Event | Category | Blocks? | Description |
|-------|----------|---------|-------------|
| [SessionStart](session/session-start.md) | [Session](session/) | No | Session begins or resumes |
| [InstructionsLoaded](session/instructions-loaded.md) | [Session](session/) | No | CLAUDE.md or rule file loaded into context |
| [Setup](session/setup.md) | [Session](session/) | No | Repo setup for init and maintenance |
| [SessionEnd](session/session-end.md) | [Session](session/) | No | Session terminates |
| [UserPromptSubmit](agentic-loop/user-prompt-submit.md) | [Agentic Loop](agentic-loop/) | Yes | User submits a prompt |
| [PreToolUse](agentic-loop/pre-tool-use.md) | [Agentic Loop](agentic-loop/) | Yes | Before a tool executes |
| [PermissionRequest](agentic-loop/permission-request.md) | [Agentic Loop](agentic-loop/) | Yes | Permission dialog displayed |
| [PostToolUse](agentic-loop/post-tool-use.md) | [Agentic Loop](agentic-loop/) | Yes | After a tool executes successfully |
| [PostToolUseFailure](agentic-loop/post-tool-use-failure.md) | [Agentic Loop](agentic-loop/) | No | After a tool execution fails |
| [Notification](agentic-loop/notification.md) | [Agentic Loop](agentic-loop/) | No | Claude Code sends a notification |
| [SubagentStart](agentic-loop/subagent-start.md) | [Agentic Loop](agentic-loop/) | No | Subagent (Agent tool call) starts |
| [SubagentStop](agentic-loop/subagent-stop.md) | [Agentic Loop](agentic-loop/) | Yes | Subagent concludes its response |
| [TaskCreated](agentic-loop/task-created.md) | [Agentic Loop](agentic-loop/) | Yes | Task created via TaskCreate tool |
| [TaskCompleted](agentic-loop/task-completed.md) | [Agentic Loop](agentic-loop/) | Yes | Task marked as completed |
| [Stop](completion/stop.md) | [Completion](completion/) | Yes | Claude finishes its response |
| [StopFailure](completion/stop-failure.md) | [Completion](completion/) | No | Turn ends due to API error |
| [TeammateIdle](completion/teammate-idle.md) | [Completion](completion/) | Yes | Teammate agent about to go idle |
| [PreCompact](context/pre-compact.md) | [Context](context/) | No | Before conversation compaction |
| [PostCompact](context/post-compact.md) | [Context](context/) | No | After conversation compaction |
| [Elicitation](mcp/elicitation.md) | [MCP](mcp/) | Yes | MCP server requests user input |
| [ElicitationResult](mcp/elicitation-result.md) | [MCP](mcp/) | Yes | User responds to MCP elicitation |
| [WorktreeCreate](async-events/worktree-create.md) | [Async](async-events/) | Yes | Worktree being created |
| [WorktreeRemove](async-events/worktree-remove.md) | [Async](async-events/) | No | Worktree being removed |
| [CwdChanged](async-events/cwd-changed.md) | [Async](async-events/) | No | Working directory changes |
| [FileChanged](async-events/file-changed.md) | [Async](async-events/) | No | Watched file changes on disk |
| [ConfigChange](async-events/config-change.md) | [Async](async-events/) | Yes | Configuration file changes during session |

## Blocking vs Non-Blocking

**Blocking hooks** can prevent an action (exit code 2 or JSON `decision: "block"`):
PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, Stop, SubagentStop, TeammateIdle, TaskCreated, TaskCompleted, ConfigChange, Elicitation, ElicitationResult, WorktreeCreate

**Non-blocking hooks** are observational — they can log, notify, or inject context but cannot prevent the action:
SessionStart, SessionEnd, InstructionsLoaded, Setup, StopFailure, PostToolUseFailure, Notification, SubagentStart, PreCompact, PostCompact, CwdChanged, FileChanged, WorktreeRemove

## Resources

**Official documentation:**
- [Hooks Reference](https://code.claude.com/docs/en/hooks) — complete schemas, matchers, exit codes for all events
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide) — practical examples and getting started

**Official diagrams** (canonical, more detailed than the ASCII above):
- [Hook Lifecycle](https://mintcdn.com/claude-code/1wr0LPds6lVWZkQB/images/hooks-lifecycle.svg) — full event flow from session start to end
- [Hook Resolution](https://mintcdn.com/claude-code/-tYw1BD_DEqfyyOZ/images/hook-resolution.svg) — how a hook resolves (event → matcher → if → handler)

**Community:**
- [claudefa.st — Complete Guide to Hooks](https://claudefa.st/blog/tools/hooks/hooks-guide) — lifecycle event walkthrough
- [Pixelmojo — CI/CD Patterns](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns) — production hook patterns
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/) — community examples and discussion
