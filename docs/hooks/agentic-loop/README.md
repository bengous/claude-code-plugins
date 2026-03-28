# Agentic Loop Hooks

Hooks in this category fire during the main interaction cycle — when Claude processes prompts, invokes tools, spawns subagents, and manages tasks. They give you control over every step of the agent loop, from the moment a user submits a prompt through tool execution, subagent orchestration, and task lifecycle. Most of these hooks can block execution, making them the primary mechanism for enforcing policies, injecting context, and automating quality gates.

## The Agentic Loop

```
 User ──► UserPromptSubmit
               │
               ▼
         ┌──────────────┐
         │ Claude turns │◄────────────────────────────────┐
         └──────┬───────┘                                 │
                │                                         │
                ▼                                         │
          PreToolUse ──deny──► (Claude adjusts)           │
                │                                         │
             allowed                                      │
                │                                         │
                ▼                                         │
        PermissionRequest ──auto-deny──► (Claude adjusts) │
                │                                         │
          approved/auto                                   │
                │                                         │
                ├──success──► PostToolUse ──────────────►─┘
                │                    │                    │
                └──failure──► PostToolUseFailure ───────►─┘

         During execution, Claude may also:

           ├──► SubagentStart ──► ... ──► SubagentStop
           ├──► TaskCreated ──► ... ──► TaskCompleted
           └──► Notification
```

## Hook Summary

| Event | Can Block? | TL;DR |
|-------|-----------|-------|
| [UserPromptSubmit](user-prompt-submit.md) | Yes | Fires when the user submits a prompt — can transform or reject it |
| [PreToolUse](pre-tool-use.md) | Yes | Fires before a tool executes — can allow, deny, or modify the call |
| [PermissionRequest](permission-request.md) | Yes | Fires when a permission dialog is about to show — can auto-approve or auto-deny |
| [PostToolUse](post-tool-use.md) | Yes | Fires after a tool succeeds — can block to force corrections or inject context |
| [PostToolUseFailure](post-tool-use-failure.md) | No | Fires after a tool execution fails |
| [Notification](notification.md) | No | Fires when Claude Code sends a desktop/system notification |
| [SubagentStart](subagent-start.md) | No | Fires when a subagent is spawned |
| [SubagentStop](subagent-stop.md) | Yes | Fires right before a subagent concludes its response |
| [TaskCreated](task-created.md) | Yes | Fires when a task is created via the TaskCreate tool |
| [TaskCompleted](task-completed.md) | Yes | Fires when a task is marked as completed |

**Official docs:** [Hooks Reference](https://code.claude.com/docs/en/hooks) · [Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
