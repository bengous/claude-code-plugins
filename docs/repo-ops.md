# Repo Ops: Branch Protection

Recovery and enforcement details for `main`/`dev`. Day-to-day rules live in `.claude/CLAUDE.md`.

## GitHub rulesets

Two rulesets exist and stack. They are not versioned in this repo; if lost, recreate with `gh api -X POST repos/bengous/claude-code-plugins/rulesets`:

- `Protect main branch`: `pull_request`, `non_fast_forward`, `deletion` on `refs/heads/main`, no bypass actors. Direct pushes to `main` are refused even for admins.
- `Require signed commits`: `required_signatures` on target `~ALL`, admin bypass kept as a recovery hatch.

There is no classic branch protection on `main`; querying `/branches/main/protection` returns 404 by design.

## Local enforcement

- lefthook `pre-commit`: `block-commit-to-main`, `block-settings-json`, `sync-settings`, `sync-versions` (auto-fix), `validate-marketplace`, `validate-frontmatter`. `commit-msg`: `block-ai-signatures`. Escape hatch for recovery only: `MAIN_BYPASS=1`.
- Claude Code PreToolUse hook: `.claude/hooks/guard-main-branch.ts`.

## CI

Triggers on `pull_request` to `main`/`dev` and on `push` to `dev` and `main`. `main` is in the push list as a backstop: a ref update reaching it outside the PR path still gets validated. The drift guard checks that `main` and `dev` share a common ancestor, not that they are identical.

## Why merge commits

Rebase-merge is disabled at the repo level: it rewrites and re-signs commits, which severed the `main`/`dev` common ancestor once. Squash-merge makes the histories diverge commit-by-commit. Merge the PR with a merge commit so `main` and `dev` stay comparable.
