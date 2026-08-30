# Research Tools Plugin

v1.2.0

Documentation research through optimal MCP sources and claim verification.

Extracted from claude-meta-tools 5.0.0.

## Skills

### `search-claude-docs`

Search the official Claude Code documentation through the `claude-code-docs` MCP
server with progressive disclosure: semantic search to locate pages, `rg`/`head`/`sed`
over the docs filesystem to read only the needed lines, and the changelog to date a
behavior by version. User-invoked only: `/search-claude-docs <question>`.

Requires the MCP server from https://code.claude.com/docs/mcp; falls back to
`WebFetch` on `llms.txt` and the raw GitHub changelog without it.

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
