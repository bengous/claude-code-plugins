---
name: search-claude-docs
description: >
  Search the official Claude Code docs through the claude-code-docs MCP server
  with progressive disclosure, and date a behavior with the changelog.
argument-hint: "[question]"
disable-model-invocation: true
compatibility: >
  Requires the claude-code-docs MCP server (https://code.claude.com/docs/mcp).
  Without it, fall back to WebFetch on https://code.claude.com/docs/llms.txt.
allowed-tools:
  - mcp__claude-code-docs__search_claude_code_docs
  - mcp__claude-code-docs__query_docs_filesystem_claude_code_docs
  - WebFetch(domain:code.claude.com)
  - WebFetch(domain:raw.githubusercontent.com)
---

# Search the Claude Code docs

Question to answer: $ARGUMENTS

The `claude-code-docs` MCP server exposes two tools. Used together they let you
answer from the published docs with an exact citation while loading a few dozen
lines into context instead of whole pages.

| Tool | What it is | Use it for |
|------|------------|------------|
| `search_claude_code_docs` | Semantic search, returns page path, anchor, and a content chunk | Locate the right page for a concept or a phrasing you cannot guess |
| `query_docs_filesystem_claude_code_docs` | Stateless read-only shell (`rg`, `grep`, `find`, `ls`, `tree`, `head`, `tail`, `sed`, `awk`, `wc`, `jq`) over a virtual filesystem holding the docs as `.mdx` | Exact keywords, reading a section, dating a change |

## Layout of the virtual filesystem

- One directory per language. English is `/en/`; other languages hold translations of the same pages.
- `/en/<page>.mdx` mirrors `https://code.claude.com/docs/en/<page>`. The SDK pages live under `/en/agent-sdk/`.
- `/en/changelog.mdx` is the full release history. Each version starts with `<Update label="2.1.251" description="August 28, 2026">`, not a markdown heading.
- `/en/whats-new/<year>-w<week>.mdx` are weekly digests that group releases with context and links.

## Workflow

1. Start with `search_claude_code_docs` when you know the concept but not the page. Read the returned paths and anchors; they are your citations. Stop here when a chunk already answers the question.
2. Switch to the filesystem tool for exact terms: an env var, a flag, a setting key, an error string, a tool name. Always give `rg` a path under `/en/`. Without a path it scans every language and floods the result with translations:
   ```
   rg -n "CLAUDE_CODE_GLOB_NO_IGNORE" /en/
   rg -n -i "bypass permissions" /en/permission-modes.mdx
   ```
3. Read only the lines you need. Every call is stateless, so combine in one command:
   ```
   rg -n "^## " /en/tools-reference.mdx            # table of contents
   sed -n '120,160p' /en/tools-reference.mdx        # one section
   head -60 /en/skills.mdx /en/sub-agents.mdx       # the top of several pages
   ```
   `cat` of a whole page costs hundreds of lines; use it only when the page is short (`wc -l` first).
4. To date a behavior, map a changelog line to its version with `awk`, which keeps the last `Update label` seen before each match:
   ```
   awk '/Update label=/{v=\$0} /Glob.*Grep|Grep.*Glob/{print v; print}' /en/changelog.mdx
   ```
   Then open the matching `/en/whats-new/` digest for the surrounding context.
5. Quote the doc verbatim when the wording carries the answer (a version number, a default, an exact flag). Paraphrase only the surrounding explanation. End with the URL form `https://code.claude.com/docs/en/<page>#<anchor>` and the version numbers you found.

## When a search comes back empty

- A regex metacharacter in the term: escape it, `rg` uses ripgrep syntax (`interface\{\}`).
- The term is a UI label, not the canonical name: search the canonical form (`TaskStop`, not `Stop Task`).
- The feature is newer than the page: check `/en/changelog.mdx` and the latest `/en/whats-new/` digest before concluding it is undocumented.
- Nothing in the docs mentions it at all: say so. An absence in the docs is itself a finding, and the user may want the GitHub issue tracker next.

## Fallbacks without the MCP server

- `WebFetch` `https://code.claude.com/docs/llms.txt` to list pages, then fetch `https://code.claude.com/docs/en/<page>`.
- For version archaeology, `WebFetch` `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`; its versions are `## 2.1.x` markdown headings, so `awk '/^## /{v=\$0} /<term>/{print v; print}'` works on a local copy.
- The `claude-code-guide` subagent answers behavior questions from the docs when you need a summary rather than a citation.

## Example

Question: "Since when are Grep and Glob missing on Linux, and how do I get them back?"

1. The `awk` mapping above prints `2.1.117` for "the `Glob` and `Grep` tools are replaced by embedded `bfs` and `ugrep`" and `2.1.162` for "`--tools`: explicitly listing Grep/Glob".
2. `rg -n "embedded" /en/changelog.mdx` confirms no later entry reverts it.
3. `rg -n "embedded search" /en/whats-new/` finds the week-23 digest with the same wording.
4. Answer: quote both changelog lines with their versions, cite `https://code.claude.com/docs/en/changelog`, and state that the opt-in is a CLI flag, since `rg -n "Grep" /en/settings-reference.mdx` finds no settings equivalent.
