# Claude Code Plugin Marketplace

One directory per plugin, listed in `.claude-plugin/marketplace.json`.

## Plugin Work

Do not reinvent plugin patterns. Delegate:

- `/plugin-dev:create-plugin` and the `plugin-dev` skills (structure, skills, hooks, agents, settings) to build or modify a plugin
- `plugin-dev:plugin-validator` agent to validate one
- `claude-code-guide` agent for Claude Code behavior questions
- Live doc search: the `claude-code-docs` MCP server (user scope, https://code.claude.com/docs/mcp)
- Official docs, the fallback when those are not installed: https://code.claude.com/docs/en/plugins

New plugin: add its `marketplace.json` entry and its `README.md` table row by hand; no check catches their absence. A plugin's version and description live in its `plugin.json` alone.

Agents never bump a version or write a `CHANGELOG.md` section: `scripts/release.ts` does both at release time.

For plugin tests, permissions and the catalog lifecycle, start at [Plugin testing](docs/plugin-testing.md) and open only the page for the task. The vellum and atlas plugins carry their own `AGENTS.md`; vellum's `.claude/rules/` have `paths:` relative to `vellum/`.

## Commands

```bash
bun test --parallel                                    # every suite outside dot directories and `archive/`
bun test --parallel ./.claude/hooks/*.test.ts          # the repo's own hooks; `bun test` skips them
bun ./scripts/run-gates.ts                             # CI's `validate` gates for what the change reaches (`--all`: everything)
bun ./scripts/affected.ts print                        # what the change reaches since origin/dev; `test` runs those suites
bun ./scripts/land.ts <branch>                         # land a branch on dev; run once in the background, its last line says what to do next
bun run --cwd vellum e2e                               # vellum's browser suite; Chromium once per machine: `bun run --cwd vellum e2e:install`
```

`vellum/`, `pinpoint/` and `atlas/` carry `package.json` + `bun.lock`: `bun install --cwd <plugin> --frozen-lockfile` before their tests or their server.

`pre-commit` and `pre-push` run the gates; CI runs them all ([Local checks and CI](docs/repo-ops/checks.md)).

## Code Standards

| Layer | Language | Boundary |
|-------|----------|----------|
| Logic | TypeScript on Bun | Parsing, branching, state. Comes with tests. |
| Glue | bash | Wiring only. Stop at ~150 lines, or at the first `jq` that builds data; past either it is logic. |

- Extensions are mandatory: `.ts`, `.tsx`, `.sh`. The gates select files by extension, so a script named without one is checked by nothing.
- Plugins are self-contained. No import crosses a plugin boundary, or reaches into `scripts/` or `.claude/`.
- Ship sources, never compiled binaries. `bun` is the runtime.

## Method

- A change of behaviour or of a data model, once a first version was delivered, is proposed before it is coded.
- One writer per worktree.
- In an agent worktree, a Bash call runs one simple command: no `&&` or `;` chain, pipe, `$(…)`, heredoc, loop or leading `cd`, and plain `git`, not `git -C`. Claude Code's worktree-isolation guard refuses a command it cannot verify stays inside the worktree. Read, Write, Edit and Grep, or a script file run as one command, do the rest.
- A step that code can decide is done by the script or the hook, not asked of Claude: an instruction can go unfollowed. A skill, a message or an error tells Claude what to do only when no code can decide it.
- A commit message says what the code does and why, the reason in words; how the change came about and how it was checked go in the pull request, or nowhere on the inline lane.

## Non-Obvious Directories

- `archive/` - retired plugins, not in the marketplace.
- `tools/oxlint/anti-slop/` - vendored lint plugin. Do not edit; re-run the upstream installer (see its README).
- `tools/oxlint/local/` - the repo's own lint plugin, edited here; registered beside anti-slop in `oxlint.config.ts`.

## Branching

`dev` is the working trunk; `main` is the release channel consumers install from, moved only by the human, by fast-forward. History is linear everywhere: no merge commits, server-enforced. Every commit carries the user's signature: the remote refuses an unsigned one, so never pass `-c commit.gpgsign=false`. `origin/dev` is the source of truth; a local `dev` goes stale each time someone else lands.

Claude Code's built-in "Commit or push only when the user asks" does not hold here: agents commit and push to `dev` (inline lane) and to their own `feature/`|`fix/` branches without asking, and land a branch with `bun ./scripts/land.ts <branch>`; `main` is the human's release, and a hook refuses every agent push to it.

Two lanes; the agent judges by scope, the user can override:

- Inline — one concern, small diff: commit directly on `dev`. A commit that touches the e2e paths (listed in `scripts/check-e2e-green.ts`) goes through a branch instead: the pre-push hook lets it reach `dev` only once its SHA has a green `e2e` run, and that run needs a pushed branch.
- Branch — several concerns, big work (large feature, large skill), or parallel agents: `feature/`|`fix/` branch, pushed, PR targeting `dev`. During a feature the branch ignores `dev`; rebase mid-feature only to pick up a commit the feature needs, or to defuse a real conflict.

Review: one agent review, once, on a branch that touches the `profile.review.risky` paths of `.claude/agent-hooks.jsonc`, whose verdict `land.ts` requires; the human reviews contracts and tests at the end of a chantier and before each release. A finding gives the input, the output observed and the cause.

Before any push or release: follow [Repo operations](docs/repo-ops.md); landing is remote-first.
