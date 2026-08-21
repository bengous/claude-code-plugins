# Claude Code Plugin Marketplace

One directory per plugin, listed in `.claude-plugin/marketplace.json`.

## Plugin Work

Do not reinvent plugin patterns. Delegate:

- `/plugin-dev:create-plugin` and the `plugin-dev` skills (structure, skills, hooks, agents, settings) to build or modify a plugin
- `plugin-dev:plugin-validator` agent to validate one
- `claude-code-guide` agent for Claude Code behavior questions
- Official docs, the fallback when those are not installed: https://code.claude.com/docs/en/plugins

New plugin: add its `marketplace.json` entry and its `README.md` table row by hand; no check catches their absence. Version bumps: edit `plugin.json` only; pre-commit propagates to the existing entry and row.

## Commands

```bash
bun test                                     # all suites
bun ./scripts/validate-marketplace.ts        # versions + structure
bun ./scripts/validate-frontmatter.ts --all  # frontmatter (default: staged only)
```

## Non-Obvious Directories

- `_shared/claude-cli/` - TypeScript SDK for hook scripts and agent spawning (input parsing, `HOOK_EXIT`, guard presets). Not a plugin. The repo's own hooks live in `.claude/hooks/`.
- `archive/` - retired plugins, not in the marketplace.
- `_docs/` - scraped external references, not plugin content.

## Branching

Merge PRs to `main` with a merge commit, never squash: the histories must stay comparable. Everything else is enforced by hooks and rulesets; details and recovery: `docs/repo-ops.md`.
