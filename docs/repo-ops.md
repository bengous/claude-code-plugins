# Repo Ops: Branch Protection

Recovery and enforcement details for `main`/`dev`. Day-to-day rules live in `.claude/CLAUDE.md`.

## GitHub rulesets

Two rulesets exist and stack. They are not versioned in this repo; if lost, recreate with `gh api -X POST repos/bengous/claude-code-plugins/rulesets`:

- `Protect main branch`: `non_fast_forward`, `deletion`, `required_linear_history` on `refs/heads/main`, no bypass actors. Every push to `main` must be a fast-forward of linear history; force pushes and merge commits are refused even for admins.
- `Linear history on dev`: `required_linear_history`, `deletion` on `refs/heads/dev`. Merge commits are refused, which also rejects `git pull` without rebase.
- `Require signed commits`: `required_signatures` on target `~ALL`, admin bypass kept as a recovery hatch.

There is no classic branch protection; querying `/branches/main/protection` returns 404 by design.

## Fast-forward flow

`main` is a delayed pointer on `dev`'s history, never a divergent branch:

- Land a branch: rebase on `dev`, then `git merge --ff-only <branch>` from the checkout holding `dev`. The later push of `dev` (end of validated task) makes GitHub mark the matching PR merged, because the same SHAs reach the base branch. The GitHub merge button is never used; rebasing locally keeps commits signed by the author's key (GitHub-side rebase would strip signatures and trip `Require signed commits`).
- Release: `git push origin dev:main`. The rulesets guarantee this is the only kind of push `main` accepts.
- Force pushes happen only on feature branches (`--force-with-lease` after a rebase), never on `dev` or `main`.

## Local enforcement

- lefthook `pre-commit`, 12 jobs in order: `block-commit-to-main`, `block-settings-json`, `sync-settings`, `sync-versions` (auto-fix), `validate-marketplace`, `validate-frontmatter`, then the six repo-wide gates `lint-config`, `typecheck`, `lint-ts`, `fmt`, `lint-sh`, `check-lint-disables`. Only the mutating jobs are order-bound: they run before the jobs that validate what they wrote. `commit-msg`: 1 job, `block-ai-signatures`. Escape hatch for recovery only: `MAIN_BYPASS=1`.
- Claude Code PreToolUse hook: `.claude/hooks/guard-main-branch.ts`.

## CI

Triggers on `pull_request` to `main`/`dev` and on `push` to `dev` and `main`. `main` is in the push list as a backstop: a ref update reaching it outside the release path still gets validated. The guard checks that `main` is an ancestor of `dev` (`git merge-base --is-ancestor`): `main` must always be a fast-forward prefix of `dev`.

## Why fast-forward

Merge commits on `main` accumulated as an ever-growing ladder `dev` never received, and GitHub's rebase-merge re-creates commits unsigned, which once severed the `main`/`dev` common ancestor. Local rebase plus fast-forward push keeps one linear signed history where `main` is a prefix of `dev` by construction.
