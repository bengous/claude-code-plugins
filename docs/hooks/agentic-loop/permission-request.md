# PermissionRequest

> Fires when a permission dialog is about to be shown to the user — can auto-approve or auto-deny.

## Basics

- **Fires when:** Claude needs user permission to execute a tool and the permission dialog is about to appear
- **Can block:** Yes — can auto-approve (skip the dialog) or auto-deny (block without asking)
- **Matcher:** Tool name

### Minimal example

```jsonc
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PermissionRequest\",\"permissionDecision\":\"allow\"}}'",
          "timeout": 5
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
| `tool_name` | `string` | Name of the tool requesting permission |
| `tool_input` | `object` | The tool's parameters |

### Stdout (JSON)

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "permissionDecision": "allow",  // "allow" | "deny"
    "permissionDecisionReason": "Auto-approved in CI environment"
  }
}
```

### Exit codes

| Exit code | Behavior |
|-----------|----------|
| `0` | Decision is read from stdout JSON |
| `0` (no stdout) | Permission dialog is shown as normal |
| `2` | Permission is denied |
| Other | Hook error — logged, dialog shown as normal |

## Patterns

### Auto-approve in CI

In headless CI environments, auto-approve all tools to prevent blocking on permission dialogs:

```bash
#!/usr/bin/env bash
# ci-auto-approve.sh
if [ -n "$CI" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"allow","permissionDecisionReason":"CI environment"}}'
fi
```

### Log permission requests

Record every permission request for audit purposes without affecting the dialog:

```bash
#!/usr/bin/env bash
# log-permission.sh
INPUT=$(cat /dev/stdin)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')
echo "[$(date -Iseconds)] Permission requested: $TOOL" >> /tmp/claude-permissions.log
# No stdout = dialog shown normally
```

## Edge Cases

- This hook fires *after* PreToolUse. If PreToolUse already allowed or denied the tool, PermissionRequest may not fire.
- Auto-approving via this hook bypasses the user's interactive permission dialog entirely — use with caution outside CI.
- If no stdout is produced, the permission dialog appears as it normally would.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide) — Auto-approve permission prompts example
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [PreToolUse](pre-tool-use.md) — fires earlier in the pipeline, before permission checks
- [PostToolUse](post-tool-use.md) — fires after the tool executes successfully
