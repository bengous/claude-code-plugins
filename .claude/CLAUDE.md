# Claude Code Plugin Marketplace

This repository is a **plugin marketplace** for Claude Code.

## Commands

```bash
mise install && lefthook install             # one-time setup (bun + lefthook)
bun test                                     # all suites
bun test scripts/__tests__/validate-marketplace.test.ts   # single test file
bun test -t "pattern"                        # single test by name
bun ./scripts/validate-marketplace.ts        # version + structure sync check
bun ./scripts/validate-frontmatter.ts --all  # frontmatter check (--all = every tracked file; default = staged only)
```

Shared validation logic lives in `scripts/lib/`; lefthook `pre-commit` and CI call the same scripts.

## Non-Obvious Directories

- `_shared/claude-cli/` - TypeScript SDK for hook scripts (hook input parsing, agent spawning, guard presets). Used by `.claude/git/` and `.claude/settings.json`. Not a plugin.
- `archive/` - retired plugins, not listed in `marketplace.json`.
- `_docs/` - scraped external references, not plugin content.

## Reference Implementations

| Plugin | Complexity | Learn From |
|--------|------------|------------|
| `git-tools/` | Medium | Commands, scripts, state management, GitHub integration |
| `orchestration/` | Advanced | Agents, skills, hooks, multi-agent coordination |

## Plugin Structure

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json        # ONLY file allowed here
├── skills/                # Slash commands and agent skills (same thing)
├── scripts/               # Backend implementation
├── hooks/                 # Optional: safety/enforcement
└── agents/                # Optional: subagent templates
```

Since Claude Code 2.x, `commands/x.md` and `skills/x/SKILL.md` both create `/x` and behave
identically. `commands/` is the legacy form, still loaded; `skills/` adds a directory for
reference files plus `disable-model-invocation` and `paths` frontmatter. Write new work as
skills. Never ship both under one name: the plugin registers two entries, the skill wins,
and the command is dead weight in the always-on budget.

## Critical Rules

| Rule | Why |
|------|-----|
| Only `plugin.json` in `.claude-plugin/` | Extra files cause silent discovery failures |
| Version sync: `plugin.json` = `marketplace.json` = `README.md` | Pre-commit hook validates all three match |
| No hardcoded paths | `${CLAUDE_PLUGIN_ROOT}` or `git rev-parse`, never `/home/user/...` |
| Repository-scoped state | `$REPO_ROOT/.myplugin`, never `$HOME/.myplugin`; global state contaminates other repos |
| Atomic writes | `jq ... > f.tmp && mv f.tmp f.json`, never `jq ... > f.json`; direct overwrites corrupt files on interruption |
| Build JSON with `jq -n --arg` | `echo "{...}"` breaks on quoting |
| Scripts must be executable | `chmod +x` required |

## Branching

- All work happens on `dev`. Never commit directly to `main`. Commits made while `main` is
  checked out are blocked locally (escape hatch: `MAIN_BYPASS=1`, for recovery only).
- `main` is updated **only via PR from `dev`**, and this is now enforced for everyone: the
  `Protect main branch` ruleset has no bypass actors, so direct pushes to `main` are refused
  even for admins. Fast-forwarding `main` by hand is no longer possible.
- **Merge the PR with a merge commit.** Rebase-merge is disabled at the repo level because it
  rewrites and re-signs commits, which is exactly what severed the `main`/`dev` common
  ancestor once already. Squash is available but makes `main`'s history diverge commit-by-commit
  from `dev`; prefer a merge commit so the two stay comparable.
- Signed commits are required on **every** branch via the GitHub ruleset `Require signed
  commits` (target `~ALL`, rule `required_signatures`). This one keeps its admin bypass as a
  recovery hatch.
- Rulesets are **not** versioned in this repo. If lost, recreate with
  `gh api -X POST repos/bengous/claude-code-plugins/rulesets`. Two exist and they stack:
  `Protect main branch` (`pull_request`, `non_fast_forward`, `deletion` on `refs/heads/main`,
  no bypass) and `Require signed commits` (admin bypass). There is no classic branch
  protection on `main`; querying `/branches/main/protection` returns 404 by design.
- Enforced by: lefthook `pre-commit` (`block-commit-to-main`, version sync, marketplace and
  frontmatter validation) + Claude Code PreToolUse hook (`guard-main-branch.ts`) + the two
  rulesets above + server CI (`.github/workflows/ci.yml`).
- CI triggers on `pull_request` to `main`/`dev` and on `push` to `dev` and `main`. `main` is
  in the push list as a backstop: if a ref update ever reaches it outside the PR path, it
  still gets validated rather than landing unchecked. The drift guard checks that `main` and
  `dev` still share a common ancestor, not that they are identical.

## Quick Start

1. Examine reference implementations: `ls git-tools/`
2. Create structure: `mkdir -p my-plugin/.claude-plugin my-plugin/skills/my-skill`
3. Copy and modify `plugin.json` from reference
4. Write one skill, test locally
5. Make scripts executable: `chmod +x scripts/*`
