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

A behaviour change to a plugin is done once the `field-test` skill has played it in a live session, red on the base and green on the change; a label, text or doc change needs none. A cloud session cannot play one: its pull request names the behaviour under **Checks** as not played in a session, and the field test is played on the owner's machine: before he approves a `tier:human` pull request, before the release for one that merged as `tier:low`.

For plugin tests, permissions and the catalog lifecycle, start at [Plugin testing](docs/plugin-testing.md) and open only the page for the task. The vellum and atlas plugins carry their own `AGENTS.md`; vellum's `.claude/rules/` have `paths:` relative to `vellum/`.

## Commands

```bash
bun test --parallel                                    # every suite outside dot directories and `archive/`
bun test --parallel ./.claude/hooks/*.test.ts          # the repo's own hooks; `bun test` skips them
bun ./scripts/gates/run-gates.ts                       # CI's `validate` gates for what the change reaches (`--all`: everything)
bun ./scripts/gates/affected.ts print                  # what the change reaches since origin/dev; `test` runs those suites
bun ./factory/scripts/check.ts --repo bengous/claude-code-plugins              # what the factory lacks on GitHub, one line per item
bun .github/factory/tier.ts replay --repo bengous/claude-code-plugins          # the tier cases, judged three times each; `--record` after an edit of `tier-prompt.md`
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
- File, path and process code goes through the platform helpers: `tools/platform/` from `scripts/` and `.claude/`, the directory's own copy elsewhere.
- Ship sources, never compiled binaries. `bun` is the runtime.

## Method

- A change of behaviour or of a data model, once a first version was delivered, is proposed before it is coded.
- One writer per worktree.
- In an agent worktree, a Bash call runs one simple command: no `&&` or `;` chain, pipe, `$(…)`, heredoc, loop or leading `cd`, and plain `git`, not `git -C`. Claude Code's worktree-isolation guard refuses a command it cannot verify stays inside the worktree. Read, Write, Edit and Grep, or a script file run as one command, do the rest.
- A step that code can decide is done by the script or the hook, not asked of Claude: an instruction can go unfollowed. A skill, a message or an error tells Claude what to do only when no code can decide it.
- A commit message says what the code does and why, the reason in words; how the change came about and how it was checked go in the pull request.

## Non-Obvious Directories

- `scripts/` - the repo's own tooling, one directory per concern (`gates/`, `releasing/`, `ci/`, `headless/`, `leads/`, `sessions/`, `reports/`), `lib/` for the helpers that belong to none. `release.ts` stays at the root.
- `.github/factory/` - this repository's tier rules and their cases, which `owner-gate.yml` runs from `dev`; the other files the factory installed (`.github/workflows/`, `.github/CODEOWNERS`, `.claude/commands/pr-review.md`) come from `factory/templates/`, adapted here.
- `archive/` - retired plugins, not in the marketplace.
- `tools/oxlint/anti-slop/` - vendored lint plugin. Do not edit; re-run the upstream installer (see its README).
- `tools/platform/` - the file, path and process helpers; edit here, then `bun ./scripts/gates/sync-platform.ts --write`; never edit a copy.
- `tools/oxlint/local/` - the repo's own lint plugin, edited here; registered beside anti-slop in `oxlint.config.ts`.

## Branching

`dev` is the trunk and the repository's default branch; `main` is the release channel consumers install from, moved only by the human, by fast-forward. A ruleset refuses every direct push to `dev`: a change reaches it as a pull request, squashed by GitHub's auto-merge once the checks `test`, `review` and `owner-gate` are green. History is linear on both: no merge commits, server-enforced. Every commit is signed: the remote refuses an unsigned one, so never pass `-c commit.gpgsign=false`. `origin/dev` is the source of truth; a local `dev` goes stale each time a pull request merges.

Claude Code's built-in "Commit or push only when the user asks" does not hold here: agents commit and push to their own `feature/`|`fix/` branches, open the pull request and turn its auto-merge on without asking; `main` is the human's release, and the owner's global `guard-git-push` hook refuses a push to `main` of a public repository; no hook of this repository guards it.

Two ways in, one gate:

- An issue the owner labels `ready`: the factory starts a cloud session on it, which implements it, verifies it and opens its pull request. `factory/README.md` describes that loop.
- A session on the owner's machine: a `feature/`|`fix/` branch from `origin/dev`, pushed, its pull request opened with `github-flow:pr`, then `gh pr merge <n> --auto --squash`. Pull requests that depend on each other form a stack (`github-flow:stacked-prs`), which lands one layer at a time, the one based on `dev` first: [Git procedures](docs/repo-ops/git.md) says how, since the skill's `gh stack sync`, `gh stack rebase` and `gh stack merge` do not pass this gate.

During a feature the branch ignores `dev`. Bring `dev` in only to pick up a commit the feature needs or to resolve a conflict, and with a merge: a pull request's branch is never rebased or force-pushed, which stops it (`CLAUDE.md`, *Stop*).

Review: `review.yml` reviews each push of each pull request and fails while it has a finding. The change sets the tier, which `owner-gate.yml` computes with `.github/factory/tier.ts`: a `tier:low` pull request merges once green, a `tier:human` one waits for the owner's `human-approved` label, which the owner alone adds and any push removes. The human reviews contracts and tests at the end of a chantier and before each release. A finding gives the input, the output observed and the cause.

Before any push or release: follow [Repo operations](docs/repo-ops.md).
