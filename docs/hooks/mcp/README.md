# MCP Hooks

Hooks that fire during MCP (Model Context Protocol) server interactions -- when an MCP server requests user input (elicitation) and when the user responds.

## Events

| Event | Fires when | Can block? |
|-------|-----------|------------|
| [Elicitation](elicitation.md) | An MCP server requests user input during a tool call | Yes |
| [ElicitationResult](elicitation-result.md) | A user responds to an MCP elicitation | Yes |

**Official docs:** [Hooks Reference](https://code.claude.com/docs/en/hooks) · [Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
