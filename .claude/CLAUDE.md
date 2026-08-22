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
bun test                                     # every suite outside dot directories
bun test ./.claude/hooks/*.test.ts           # the repo's own hooks; `bun test` skips them
bun ./scripts/validate-marketplace.ts        # versions + structure
bun ./scripts/validate-frontmatter.ts --all  # frontmatter (default: staged only)
bun x tsgo --noEmit                          # types; fall back to ./node_modules/.bin/tsc --noEmit if tsgo rejects a flag
bun x oxlint                                 # lint (correctness + suspicious + pedantic + anti-slop)
bun x oxfmt '**/*.ts' '**/*.js'              # format; add --check to verify only
bun ./scripts/lint-shell.ts                  # shellcheck + shfmt; takes paths, else the whole repo
bun ./scripts/check-lint-disables.ts         # every lint suppression must say why on its line
```

Every lint suppression needs ` -- <reason>` on the same line, or the last command rejects it. All of these run in `pre-commit` and again in CI, with the same arguments.

## Non-Obvious Directories

- `archive/` - retired plugins, not in the marketplace.
- `_docs/` - scraped external references, not plugin content.
- `tools/oxlint/anti-slop/` - vendored lint plugin. Do not edit; re-run the upstream installer (see its README).

## Branching

Merge PRs to `main` with a merge commit, never squash: the histories must stay comparable. Everything else is enforced by hooks and rulesets; details and recovery: `docs/repo-ops.md`.
