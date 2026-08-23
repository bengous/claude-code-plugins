# Claude Code Plugin Marketplace

One directory per plugin, listed in `.claude-plugin/marketplace.json`.

## Plugin Work

Do not reinvent plugin patterns. Delegate:

- `/plugin-dev:create-plugin` and the `plugin-dev` skills (structure, skills, hooks, agents, settings) to build or modify a plugin
- `plugin-dev:plugin-validator` agent to validate one
- `claude-code-guide` agent for Claude Code behavior questions
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

The six tooling gates (`check-lint-config.ts`, `tsgo`, `oxlint`, `oxfmt --check`, `lint-shell.ts`, `check-lint-disables.ts`) run in `pre-commit` and again in CI, same arguments both times; `validate-marketplace.ts` too. `pre-commit` runs `validate-frontmatter.ts` on staged files only, CI runs it with `--all`. Neither test command runs in `pre-commit`: `lefthook.yml` declares no test job, so both `bun test` runs are CI-only.

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

`dev` is the working trunk; `main` is the release channel consumers install from, moved only by fast-forward (`git push origin dev:main`). History is linear everywhere: no merge commits, server-enforced.

- Small single-concern change: commit directly on `dev`, atomic and curated.
- Big work (large feature, large skill), several concerns, or parallel agents: branch or PR stack targeting `dev`, agent review per PR.
- Review: agents review each other's PRs; the human reviews contracts and tests at the end of a chantier and before each release.

Landing is local: rebase on `dev`, then fast-forward `dev` (`git merge --ff-only <branch>` from the checkout holding `dev`). Pushing to origin is a separate publish step, done when the user asks — never a default part of landing. For a PR, the eventual push of `dev` marks it merged; never use the GitHub merge button.

Worktree sessions cannot move `dev`: it is checked out in the main checkout and git refuses (`git branch -f` and local push alike). Commit on the worktree branch, then hand the fast-forward to the main checkout.

Details and recovery: `docs/repo-ops.md`.
