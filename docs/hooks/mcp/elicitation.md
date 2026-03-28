# Elicitation

> Fires when an MCP server requests user input during a tool call.

## Basics

- **Fires when:** An MCP server triggers an elicitation (interactive prompt) during tool execution
- **Can block:** Yes
- **Matcher:** N/A -- no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "Elicitation": [
      {
        "hooks": [{
          "type": "command",
          "command": "my-elicitation-handler",
          "timeout": 10
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
| `cwd` | `string` | Working directory |
| `mcp_server` | `object` | MCP server info (name, id) |
| `elicitation` | `object` | Elicitation details (schema, prompt, context) |

### Stdout / Exit codes

Return a block decision to prevent the elicitation from being shown to the user.

| Exit code | Meaning |
|-----------|---------|
| `0` | Hook ran successfully |
| Non-zero | Hook failed -- elicitation proceeds normally |

## Patterns

### Auto-respond to known elicitations

Skip interactive prompts for known, safe elicitation patterns by providing a pre-configured response.

```bash
#!/usr/bin/env bash
input=$(cat)
server=$(printf '%s' "$input" | jq -r '.mcp_server.name')
# Auto-approve known safe servers
if [ "$server" = "trusted-server" ]; then
  printf '{"decision":"block","reason":"Auto-approved for trusted server"}'
fi
```

### Audit MCP interactions

Log all elicitation requests for security auditing.

```bash
#!/usr/bin/env bash
input=$(cat)
printf '%s' "$input" | jq -c '{event: "elicitation", ts: now, server: .mcp_server.name}' \
  >> ~/.local/share/etch/mcp-audit.jsonl
```

## Edge Cases

- Blocking an elicitation prevents the MCP server from getting user input, which may cause the tool call to fail.
- Fast execution is important -- the user is waiting for the elicitation prompt.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [ElicitationResult](elicitation-result.md) -- fires after the user responds
