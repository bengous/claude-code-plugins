# Completion Hooks

Hooks that fire when Claude finishes responding or a turn ends. Use these to validate work before Claude stops, handle API failures, or manage teammate lifecycle.

## Events

| Event | Fires when | Can block? |
|-------|-----------|------------|
| [Stop](stop.md) | Claude is about to conclude its response | Yes |
| [StopFailure](stop-failure.md) | A turn ends due to an API error | No |
| [TeammateIdle](teammate-idle.md) | A teammate agent is about to go idle | Yes |

**Official docs:** [Hooks Reference](https://code.claude.com/docs/en/hooks) · [Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
