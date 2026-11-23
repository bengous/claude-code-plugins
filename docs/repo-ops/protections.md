# GitHub branch protections

[Repo operations index](../repo-ops.md). Read when a server rule rejects a push or when rulesets need recovery.

Four rulesets exist and stack. They are not versioned in this repo; if lost, recreate with `gh api -X POST repos/bengous/claude-code-plugins/rulesets`. None has a bypass actor: `bun ./factory/scripts/check.ts --repo bengous/claude-code-plugins` reports one, and every rule the factory needs that is missing.

- `dev`: on the default branch (`~DEFAULT_BRANCH`). `deletion`, `non_fast_forward`, `required_linear_history`; `pull_request`, squash merge alone, review threads resolved, a code owner's review of a path of `.github/CODEOWNERS`; `required_status_checks`, `test`, `review` and `owner-gate`. No push reaches `dev`: a change is a pull request whose three checks are green. [`factory/skills/install/SKILL.md`](../../factory/skills/install/SKILL.md) holds the body the ruleset was created from.
- `Protect main branch`: `non_fast_forward`, `deletion`, `required_linear_history` on `refs/heads/main`. Every push to `main` must be a fast-forward of linear history; force pushes and merge commits are refused even for admins.
- `Require signed commits`: `required_signatures` on target `~ALL`. A cloud session's commits are signed by Claude, a squash commit by GitHub, Renovate's by GitHub.
- `Require green CI on main`: `required_status_checks` (checks `validate` and `test` from GitHub Actions) on `refs/heads/main`. A push may move `main` only to a SHA that already carries both green. A pull request's head carries a `test` too, over the suites its change reaches alone; `validate` under that name is a push's or a dispatch's, which run every suite and kit, the browser suite among them ([Local checks and CI](checks.md#ci)).

Repository settings the factory needs, which `check.ts` also reads: auto-merge allowed, squash merge allowed. A merged pull request's branch is deleted, and a squash commit takes the pull request's title with an empty body: `check.ts` reads neither.

The workflows take three label moves as the owner's: `human-approved` on and `ready` on when his login made them with no app behind it, `needs-human` off on his login alone, since GitHub records no app behind a label removed (`review.yml` asks for a comment of his beside it, `conflict.yml` for nothing more). A session on the owner's machine writes with his token, so nothing on GitHub tells its move from his. `.claude/hooks/guard-owner-labels.ts` denies such a session's command that makes one, or that replaces or clears every label of an issue, read as text: a command that spells the label another way goes through.

There is no classic branch protection; querying `/branches/main/protection` returns 404 by design.
