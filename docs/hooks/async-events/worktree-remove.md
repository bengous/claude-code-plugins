# WorktreeRemove

> Fires when a worktree is being removed.

## Basics

- **Fires when:** Claude Code is removing a git worktree
- **Can block:** No
- **Matcher:** N/A -- no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "WorktreeRemove": [
      {
        "hooks": [{
          "type": "command",
          "command": "my-worktree-cleanup",
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
| `worktree_path` | `string` | Absolute path of the worktree being removed |
| `cwd` | `string` | Working directory |

### Stdout / Exit codes

Output is ignored -- this is a notification-only hook.

## Patterns

### Cleanup worktree-specific resources

Remove caches, temp files, or database entries associated with the worktree.

```bash
#!/usr/bin/env bash
input=$(cat)
wt_path=$(printf '%s' "$input" | jq -r '.worktree_path')
# Remove worktree-specific cache
rm -rf "${wt_path}/.cache" 2>/dev/null || true
echo "[$(date -Iseconds)] Removed worktree: $wt_path" \
  >> ~/.local/share/etch/worktree.log
```

## Edge Cases

- The worktree directory may already be partially removed when this hook fires.
- Keep cleanup idempotent -- the hook may fire for worktrees that were already cleaned up.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [WorktreeCreate](worktree-create.md) -- fires when a worktree is created
