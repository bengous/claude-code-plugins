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
- Rulesets are **not** versioned in this repo — if lost, recreate with
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
  `dev` still share a common ancestor — not that they are identical.

## Quick Start

1. Examine reference implementations: `ls git-tools/`
2. Create structure: `mkdir -p my-plugin/.claude-plugin my-plugin/commands`
3. Copy and modify `plugin.json` from reference
4. Write one command, test locally
5. Make scripts executable: `chmod +x scripts/*`
