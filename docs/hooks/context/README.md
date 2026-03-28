# Context Hooks

Hooks that fire around conversation compaction -- when Claude Code compresses prior messages to stay within context limits.

## Events

| Event | Fires when | Can block? |
|-------|-----------|------------|
| [PreCompact](pre-compact.md) | Before conversation compaction begins | No |
| [PostCompact](post-compact.md) | After conversation compaction completes | No |

**Official docs:** [Hooks Reference](https://code.claude.com/docs/en/hooks) · [Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
