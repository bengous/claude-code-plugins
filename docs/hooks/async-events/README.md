# Async Event Hooks

Hooks that fire independently of the main agentic loop -- in response to filesystem changes, configuration updates, and worktree operations. They can happen at any point during a session.

## Events

| Event | Fires when | Can block? |
|-------|-----------|------------|
| [WorktreeCreate](worktree-create.md) | Claude Code creates an isolated worktree | Yes |
| [WorktreeRemove](worktree-remove.md) | A worktree is being removed | No |
| [CwdChanged](cwd-changed.md) | The working directory changes | No |
| [FileChanged](file-changed.md) | A watched file changes on disk | No |
| [ConfigChange](config-change.md) | A configuration file changes during a session | Yes |

**Official docs:** [Hooks Reference](https://code.claude.com/docs/en/hooks) · [Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
