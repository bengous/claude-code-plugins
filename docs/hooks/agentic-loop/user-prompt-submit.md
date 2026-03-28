# UserPromptSubmit

> Fires when the user submits a prompt, before Claude begins processing it.

## Basics

- **Fires when:** The user presses Enter on a prompt (or a programmatic prompt is submitted)
- **Can block:** Yes — exit 2 rejects the prompt; hookSpecificOutput can transform it
- **Matcher:** N/A — no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "cat > /tmp/last-prompt.txt",
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
| `prompt` | `string` | The text the user submitted |

### Stdout / Exit codes

| Exit code | Behavior |
|-----------|----------|
| `0` | Prompt proceeds unchanged (or modified via stdout) |
| `2` | Prompt is rejected — Claude does not process it |
| Other | Hook error — logged, prompt proceeds |

To modify the prompt, write JSON to stdout:

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "modifiedPrompt": "Enhanced prompt text here"
  }
}
```

## Patterns

### Inject system context

Prepend project-specific context to every prompt so Claude always has current state:

```bash
#!/usr/bin/env bash
# inject-context.sh
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
CONTEXT="[Branch: $BRANCH | Worktree: $(basename "$PWD")]"

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "$CONTEXT"
  }
}
EOF
```

### Validate prompt content

Reject prompts that reference sensitive paths or banned operations:

```bash
#!/usr/bin/env bash
# validate-prompt.sh
PROMPT=$(jq -r '.prompt' < /dev/stdin)

if echo "$PROMPT" | grep -qiE '(production|prod\s+database|deploy to main)'; then
  echo "Blocked: prompt references production systems" >&2
  exit 2
fi
```

## Edge Cases

- Fires for every prompt submission, including `/commands` that resolve to prompts.
- If the hook modifies the prompt, Claude sees only the modified version — the original is not preserved in context.
- Multiple hooks run sequentially; if any exits 2, the prompt is rejected regardless of other hooks.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [PreToolUse](pre-tool-use.md) — control what tools Claude can invoke after the prompt
- [Notification](notification.md) — fires on outbound notifications, not inbound prompts
