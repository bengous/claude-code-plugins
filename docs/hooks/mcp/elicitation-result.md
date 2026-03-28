# ElicitationResult

> Fires after a user responds to an MCP elicitation.

## Basics

- **Fires when:** The user has submitted a response to an MCP server's elicitation prompt
- **Can block:** Yes
- **Matcher:** N/A -- no matcher support

### Minimal example

```jsonc
{
  "hooks": {
    "ElicitationResult": [
      {
        "hooks": [{
          "type": "command",
          "command": "my-elicitation-result-handler",
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
| `response` | `object` | The user's response to the elicitation |
| `elicitation` | `object` | Original elicitation context |

### Stdout / Exit codes

Return a block decision to prevent the response from being sent to the MCP server.

| Exit code | Meaning |
|-----------|---------|
| `0` | Hook ran successfully |
| Non-zero | Hook failed -- response proceeds normally |

## Patterns

### Validate user responses

Check the user's response against business rules before it reaches the MCP server.

```bash
#!/usr/bin/env bash
input=$(cat)
response=$(printf '%s' "$input" | jq -r '.response')
# Validate response meets requirements
if printf '%s' "$response" | jq -e '.contains_sensitive_data' > /dev/null 2>&1; then
  printf '{"decision":"block","reason":"Response contains sensitive data"}'
fi
```

### Log elicitation results

Track all MCP elicitation responses for auditing.

```bash
#!/usr/bin/env bash
input=$(cat)
printf '%s' "$input" | jq -c '{event: "elicitation_result", ts: now, server: .mcp_server.name}' \
  >> ~/.local/share/etch/mcp-audit.jsonl
```

## Edge Cases

- Blocking the result prevents the MCP server from receiving the user's response, which may leave the tool call in a pending state.

## Resources

- [Hooks Reference](https://code.claude.com/docs/en/hooks) — official documentation
- [Reddit — All Hooks Explained](https://www.reddit.com/r/ClaudeAI/comments/1rxu41b/)

## See Also

- [Elicitation](elicitation.md) -- fires when the elicitation is first requested
