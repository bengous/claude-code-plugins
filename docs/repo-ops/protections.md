# GitHub branch protections

[Repo operations index](../repo-ops.md). Read when a server rule rejects a push or when rulesets need recovery.

Four rulesets exist and stack. They are not versioned in this repo; if lost, recreate with `gh api -X POST repos/bengous/claude-code-plugins/rulesets`:

- `Protect main branch`: `non_fast_forward`, `deletion`, `required_linear_history` on `refs/heads/main`, no bypass actors. Every push to `main` must be a fast-forward of linear history; force pushes and merge commits are refused even for admins.
- `Linear history on dev`: `required_linear_history`, `deletion` on `refs/heads/dev`. Merge commits are refused, which also rejects `git pull` without rebase.
- `Require signed commits`: `required_signatures` on target `~ALL`, admin bypass kept as a recovery hatch.
- `Require green CI on main`: `required_status_checks` (check `validate` from GitHub Actions) on `refs/heads/main`. A push may move `main` only to a SHA that already carries a green `validate` run. That is the push or dispatch run, which runs every suite and kit: a pull request's run is named `validate (scoped)` ([Local checks and CI](checks.md#ci)), and `win32` is not required yet. `dev` stays unprotected on purpose: CI detects a red `dev` after the fact, and this rule keeps it out of `main` (issue #67, option B).

There is no classic branch protection; querying `/branches/main/protection` returns 404 by design.
