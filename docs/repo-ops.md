# Repo operations

Choose the procedure for the task. `AGENTS.md` owns the branch model, `CLAUDE.md` the rules a pull request follows; these pages own the operational details.

| Task | Read |
|---|---|
| Open a pull request, follow it to its merge, land a stack, refresh a checkout or release | [Git procedures](repo-ops/git.md) |
| Pick the commits of the weekly sampled review | [Git procedures](repo-ops/git.md#sampled-review) |
| Measure the week's frictions of the agent workflow | [Git procedures](repo-ops/git.md#friction-report) |
| Diagnose a failed hook or CI job; change validation | [Local checks and CI](repo-ops/checks.md) |
| Read a `flaky` issue, or a test CI passed on its retry | [Flaky tests](repo-ops/checks.md#flaky-tests) |
| Diagnose a server rejection or recover a ruleset | [GitHub branch protections](repo-ops/protections.md) |
| Inspect plugin synchronization after a merge | [Managed catalog](plugin-testing/catalog.md) |
| Set up, run or pause the leads pipeline; sort the leads it files | [Leads pipeline](repo-ops/leads.md) |
| Change what a cloud session can reach, or the tools it runs | [Cloud environment](repo-ops/cloud.md) |

Code reaches `dev` through a pull request alone. Read the Git procedure before any push or release.
`main` remains the human-controlled release channel.
