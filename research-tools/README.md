# Research Tools Plugin

v1.0.0

Documentation research through optimal MCP sources and claim verification.

Extracted from claude-meta-tools 5.0.0.

## Commands

### `/research`

Research documentation using optimal MCP sources. Delegates to the `research-agent`
subagent, which picks the best source (project MCP docs, Context7, exa, web search) and
returns synthesized results.

```bash
/research TanStack Query invalidation
```

### `/how-to-research`

Learn which MCP tools to use for researching a topic. Delegates to the `research-teacher`
subagent, which discovers the tools and returns exact call syntax — it teaches, it does not
research.

### `/fact-check`

Verify claims using web search and report findings with sources.

### `/fact-check-code`

Verify claims about the codebase by searching code and optionally the web.

## Agents

- **research-agent** — executes research and returns synthesized results (Execute pattern)
- **research-teacher** — discovers tools and teaches invocation syntax (Teach pattern)

## License

MIT

## Author

Augustin BENGOLEA <bengous@protonmail.com>
