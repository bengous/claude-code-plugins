# Claude Code Plugin Marketplace

One directory per plugin, listed in `.claude-plugin/marketplace.json`.

## Plugin Work

Do not reinvent plugin patterns. Delegate:

- `/plugin-dev:create-plugin` and the `plugin-dev` skills (structure, skills, hooks, agents, settings) to build or modify a plugin
- `plugin-dev:plugin-validator` agent to validate one
- `claude-code-guide` agent for Claude Code behavior questions
- Live doc search: the `claude-code-docs` MCP server (user scope, https://code.claude.com/docs/mcp)
- Official docs, the fallback when those are not installed: https://code.claude.com/docs/en/plugins

New plugin: add its `marketplace.json` entry and its `README.md` table row by hand; no check catches their absence. Version bumps: edit `plugin.json` only; pre-commit propagates to the existing entry and row.

Testing a plugin from source (launch flags, permission modes, transcript checks): `docs/plugin-testing.md`.

## Commands

```bash
bun test                                               # every suite outside dot directories
bun test ./.claude/hooks/*.test.ts                     # the repo's own hooks; `bun test` skips them
bun ./scripts/validate-marketplace.ts                  # versions + structure
bun ./scripts/validate-frontmatter.ts --all            # frontmatter (default: staged only)
bun x tsgo --noEmit                                    # types; fall back to ./node_modules/.bin/tsc --noEmit if tsgo rejects a flag
bun x oxlint                                           # lint (correctness + suspicious + pedantic + anti-slop)
bun x oxfmt '**/*.ts' '**/*.js' '**/*.mjs' '**/*.cjs'  # format; add --check to verify only
bun ./scripts/lint-shell.ts                            # shellcheck + shfmt; takes paths, else the whole repo
```

Everything above also runs in `pre-commit` and CI except `bun test`: `lefthook.yml` declares no test job, so run the tests yourself before pushing. Job list, order, and argument differences: `docs/repo-ops.md`.

## Code Standards

| Layer | Language | Boundary |
|-------|----------|----------|
| Logic | TypeScript on Bun | Parsing, branching, state. Comes with tests. |
| Glue | bash | Wiring only. Stop at ~150 lines, or at the first `jq` that builds data; past either it is logic. |

That bash boundary binds new code. Scripts already over it move when an issue rewrites them, not before.

Carried by the commands above:

- Extensions are mandatory: `.ts`, `.sh`. `tsgo`, `oxlint`, `oxfmt` and `check-lint-disables.ts` select files by extension, so a Bun script named without `.ts` is checked by nothing. `lint-shell.ts` also matches a shell shebang, so bash survives an extensionless name.
- One root `tsconfig.json` covers every `.ts` outside `archive/` and the vendored linter: `strict`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Do not add a second one.
- Every lint suppression says why on its own line: `// oxlint-disable-next-line <rule> -- <reason>`. `check-lint-disables.ts` rejects the bare form, `oxlint-` and `eslint-` spellings alike.

Carried by nobody, so hold them by hand:

- Plugins are self-contained. No import crosses a plugin boundary, or reaches into `scripts/` or `.claude/`. Today every relative import stays inside its own top-level directory, and none climbs past a single `../`.
- Ship sources, never compiled binaries. `bun` is the runtime.

## Non-Obvious Directories

- `archive/` - retired plugins, not in the marketplace.
- `tools/oxlint/anti-slop/` - vendored lint plugin. Do not edit; re-run the upstream installer (see its README).

## Branching

`dev` is the working trunk; `main` is the release channel consumers install from, moved only by the human, by fast-forward. History is linear everywhere: no merge commits, server-enforced. `origin/dev` is the source of truth; every local `dev` is a cache that goes stale each time someone else lands.

Two lanes; the agent judges by scope, the user can override:

- Inline — one concern, small diff: commit directly on `dev`.
- Branch — several concerns, big work (large feature, large skill), or parallel agents: `feature/`|`fix/` branch, pushed, PR targeting `dev`, agent review per PR. During a feature the branch ignores `dev`; rebase mid-feature only to pick up a commit the feature needs, or to defuse a real conflict.

Review: agents review each other's PRs; the human reviews contracts and tests at the end of a chantier and before each release.

Before any push or release: follow `docs/repo-ops.md`; landing is remote-first.
