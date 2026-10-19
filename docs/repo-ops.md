# Repo operations

Choose the procedure for the task. `AGENTS.md` owns the branch model and lane
choice; these pages own the operational details.

| Task | Read |
|---|---|
| Push a branch, land a branch or a stack on dev, refresh a checkout or release | [Git procedures](repo-ops/git.md) |
| Pick the commits of the weekly sampled review | [Git procedures](repo-ops/git.md#sampled-review) |
| Diagnose a failed hook or CI job; change validation | [Local checks and CI](repo-ops/checks.md) |
| Read a `flaky` issue, or a test CI passed on its retry | [Flaky tests](repo-ops/checks.md#flaky-tests) |
| Diagnose a server rejection or recover a ruleset | [GitHub branch protections](repo-ops/protections.md) |
| Inspect plugin synchronization after a landing | [Managed catalog](plugin-testing/catalog.md) |

Landings are remote-first. Read the Git procedure before any push or release.
`main` remains the human-controlled release channel.
