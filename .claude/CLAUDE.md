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
bun ./scripts/check-lint-disables.ts         # gate for the suppression rule below
```

The five tooling gates (`tsgo`, `oxlint`, `oxfmt --check`, `lint-shell.ts`, `check-lint-disables.ts`) run in `pre-commit` and again in CI, same arguments both times; `validate-marketplace.ts` too. `pre-commit` runs `validate-frontmatter.ts` on staged files only, CI runs it with `--all`. Neither test command runs in `pre-commit`: `lefthook.yml` declares no test job, so both `bun test` runs are CI-only.

## Code Standards

| Layer | Language | Boundary |
|-------|----------|----------|
| Logic | TypeScript on Bun | Parsing, branching, state. Comes with tests. |
| Glue | bash | Wiring only. Stop at ~150 lines, or at the first `jq` that builds data; past either it is logic. |

That bash boundary binds new code. Scripts already over it move when an issue rewrites them, not before.

Carried by the commands above:

- Extensions are mandatory: `.ts`, `.sh`. `tsgo`, `oxlint`, `oxfmt` and `check-lint-disables.ts` select files by extension, so a Bun script named without `.ts` is checked by nothing. `lint-shell.ts` also matches a shell shebang, so bash survives an extensionless name.
- One root `tsconfig.json` covers every `.ts` outside `archive/`, `_docs/` and the vendored linter: `strict`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Do not add a second one.
- Every lint suppression says why on its own line: `// oxlint-disable-next-line <rule> -- <reason>`. `check-lint-disables.ts` rejects the bare form, `oxlint-` and `eslint-` spellings alike.

Carried by nobody, so hold them by hand:

- Plugins are self-contained. No import crosses a plugin boundary, or reaches into `scripts/` or `.claude/`. Today all 17 relative imports stay inside their own top-level directory, and none climbs past a single `../`.
- Ship sources, never compiled binaries. `bun` is the runtime.

## Non-Obvious Directories

- `archive/` - retired plugins, not in the marketplace.
- `_docs/` - scraped external references, not plugin content.
- `tools/oxlint/anti-slop/` - vendored lint plugin. Do not edit; re-run the upstream installer (see its README).

## Branching

Merge PRs to `main` with a merge commit, never squash: the histories must stay comparable. Everything else is enforced by hooks and rulesets; details and recovery: `docs/repo-ops.md`.
