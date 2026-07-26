# Claude Code Plugin Marketplace

This repository is a **plugin marketplace** for Claude Code.

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
├── commands/              # Slash commands (required)
├── scripts/               # Backend implementation
├── hooks/                 # Optional: safety/enforcement
├── agents/                # Optional: subagent templates
└── skills/                # Optional: agent skills
```

## Critical Rules

| Rule | Why |
|------|-----|
| Only `plugin.json` in `.claude-plugin/` | Extra files cause silent discovery failures |
| Version sync: `plugin.json` = `marketplace.json` = `README.md` | Pre-commit hook validates all three match |
| No hardcoded paths | Use `${CLAUDE_PLUGIN_ROOT}` or `git rev-parse` |
| Repository-scoped state | Global state causes cross-repo contamination |
| Atomic writes | Direct overwrites corrupt files on interruption |
| Scripts must be executable | `chmod +x` required |

## Common Pitfalls

| Pitfall | Wrong | Right |
|---------|-------|-------|
| Hardcoded paths | `/home/user/...` | `${CLAUDE_PLUGIN_ROOT}` |
| Global state | `$HOME/.myplugin` | `$REPO_ROOT/.myplugin` |
| Non-atomic writes | `jq ... > f.json` | `jq ... > f.tmp && mv f.tmp f.json` |
| Version desync | Different versions | Must match exactly |
| JSON concatenation | `echo "{...}"` | `jq -n --arg ...` |

## Branching

- All work happens on `dev`. Never commit directly to `main` — commits made while `main` is
  checked out are blocked locally (escape hatch: `MAIN_BYPASS=1`, for recovery only).
- `main` advances by **fast-forward from `dev`**, never by a merge commit or a rebase:
  `git push origin dev:main`. Rebase-merging re-signs commits and severs the `main`/`dev`
  common ancestor, which is the failure this setup exists to prevent.
- A PR from `dev` is the intended route and the only one non-admins have. The
  `Protect main branch` ruleset carries a `pull_request` rule, but its bypass actor is the
  admin role in `always` mode, so an admin's direct fast-forward push succeeds. Treat the
  PR as convention, not as a guarantee the server will enforce against you.
- Signed commits are required on **every** branch via the GitHub ruleset `Require signed
  commits` (target `~ALL`, rule `required_signatures`, same admin bypass).
- Rulesets are **not** versioned in this repo — if lost, recreate with
  `gh api -X POST repos/bengous/claude-code-plugins/rulesets`. Two exist and they stack:
  `Protect main branch` (`pull_request`, `non_fast_forward`, `deletion` on `refs/heads/main`)
  and `Require signed commits`. There is no classic branch protection on `main`; querying
  `/branches/main/protection` returns 404 by design.
- Enforced by: lefthook `pre-commit` (`block-commit-to-main`, version sync, marketplace and
  frontmatter validation) + Claude Code PreToolUse hook (`guard-main-branch.ts`) + the two
  rulesets above + server CI (`.github/workflows/ci.yml`).
- **CI gap to know about:** the workflow triggers on `pull_request` to `main`/`dev` and on
  `push` to `dev` only. A direct fast-forward push to `main` runs no CI, so validate on
  `dev` first and confirm it is green before advancing `main`. The workflow's drift guard
  checks that `main` and `dev` still share a common ancestor — not that they are identical.

## Quick Start

1. Examine reference implementations: `ls git-tools/`
2. Create structure: `mkdir -p my-plugin/.claude-plugin my-plugin/commands`
3. Copy and modify `plugin.json` from reference
4. Write one command, test locally
5. Make scripts executable: `chmod +x scripts/*`
