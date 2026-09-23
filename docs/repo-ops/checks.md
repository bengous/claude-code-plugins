# Local checks and CI

[Repo operations index](../repo-ops.md). Read when a gate fails or when the validation machinery changes.

## Local enforcement

The checks run as a ladder, from each edit to CI: the Claude Code post-edit fixer and formatter, the Stop gates, `pre-commit`, `pre-push`, then CI.

- lefthook `pre-commit`, 14 jobs in order: `block-commit-to-main`, `block-settings-json`, `sync-settings`, `sync-versions` (auto-fix), `validate-marketplace`, `validate-frontmatter`, then the six repo-wide gates `lint-config`, `typecheck`, `lint-ts`, `fmt`, `lint-sh`, `check-lint-disables`, then `validate-vellum` and `test-vellum` on the module's paths (`vellum/hooks/*`, `vellum/src/core/engine/**`, the manifest). Only the mutating jobs are order-bound: they run before the jobs that validate what they wrote. `commit-msg`: 1 job, `block-ai-signatures`. Escape hatch for recovery only: `MAIN_BYPASS=1`.
- lefthook `pre-push`, 1 script job, `gates-and-tests` (`.lefthook/pre-push/gates-and-tests.sh`): the release guard and the e2e gate below, then `scripts/run-gates.ts`, every gate unscoped as CI runs it, then both `bun test` runs. It first unsets the variables `git rev-parse --local-env-vars` lists: a push from a linked worktree exports `GIT_DIR`, which would send the suites' temp-repo commits to the pushing repo. A script, not a `run` job, because lefthook skips or fails a pre-push `run` job on its pushed-files lookup (reason in `lefthook.yml`). The gates and tests check the working tree, not the pushed commits. A push that only deletes refs skips it: `use_stdin` passes git's ref lines to the script, and a null local oid on every line exits before any gate.
- The release guard, `scripts/check-plugin-bumps.ts --pre-push`, gets the same ref lines and reads only a line whose remote ref is `refs/heads/main`. From that line's remote oid to its local oid, with no fetch, it refuses the push and names each marketplace plugin whose directory changed while its `plugin.json` `version` did not: a plugin is matched across both catalogs by its entry's `name` and read at each side's `source`, so a moved directory is compared with where it was; a plugin the remote's `main` does not list, or one retired from the catalog, passes. It also refuses a push to `main` when the remote has none (null remote oid) or holds a commit the pushing repo lacks. A push to any other ref passes untouched, so `dev` is never blocked between a plugin change and its release-time bump. It is no `EXPECTED_COMMANDS` entry: `run-gates.ts` would run it on every push and at every Stop, red for that whole window. No CI step either: on a push to `main`, CI's `origin/main` is already the pushed commit. By hand: `bun ./scripts/check-plugin-bumps.ts <base-ref> <head-ref>`.
- The e2e gate, `scripts/check-e2e-green.ts`, gets the same ref lines and reads only a line whose remote ref is `refs/heads/dev`. It lists the paths that differ from that line's remote oid to its local oid, with no fetch (the whole tree when the remote has no `dev`), and keeps the e2e paths, which the script alone lists (`E2E_PATHS`, `NOT_E2E_PATHS`; what they cover: [Which suite runs on which trigger](#which-suite-runs-on-which-trigger)). When one is touched, it reads the local oid's check runs (`gh api repos/{owner}/{repo}/commits/<sha>/check-runs`) and refuses the push unless one run named `e2e` concluded `success`, whatever the others say. The refusal names the SHA, the first touched path, the runs found, and the next command, chosen by what was found. With no `e2e` run, or only `skipped` ones, it is a request ([CI](#ci)): `gh pr edit <branch> --add-label e2e`, or `gh workflow run ci.yml --ref <branch>` for a branch with no pull request. A `skipped` run is what a run nobody asked `e2e` of leaves on the SHA, and re-running it replays the same event, skipped again. With a run still going, it is `gh run watch <run-id>`. When every run that executed ended red, it is `gh run rerun --job <id>` on the newest of them: a check run's id is its job's id, and pushing the same SHA again starts no run. A `gh` failure refuses too and quotes it: offline, unauthenticated, or a commit GitHub has never seen, which is pushed first, then asked for a run. A push that touches no e2e path, or goes to any other ref, passes without calling `gh`. `git push --no-verify` skips it, and so does `LEFTHOOK=0`, which skips every lefthook job. The gate reads no bypass variable of its own. It is no `EXPECTED_COMMANDS` entry: it needs the network and a run that already happened.
- CI parity: the six tooling gates and `validate-marketplace.ts` run again in CI with the same arguments. `validate-frontmatter.ts` runs on staged files in `pre-commit`, with `--all` in `pre-push` and CI. Neither `bun test` command runs in `pre-commit`; the hooks module's kit (`test-vellum`, `claude plugin test vellum`) does, when a staged path matches its glob.
- CI's Claude Code: `jdx/mise-action` caches installs under the hash of `mise.toml`, so `claude = "latest"` stays where the cache first resolved it. The step after it runs `mise upgrade claude` and prints the version, since the hooks module's kit runs on the engine and `vellum/types/claude-code.d.ts` follows the local one. A kit red in CI and green locally: compare that printed version with `claude --version` first.
- Claude Code PreToolUse hooks: `.claude/hooks/guard-main-branch.ts` (no commit/push on a `main` checkout), `.claude/hooks/guard-git-push.ts` (no push targeting `main`, no force push targeting `dev` — the rulesets accept both, so only the hook refuses them agent-side). Both police the repo their file lives in, linked worktrees included, whatever `CLAUDE_PROJECT_DIR` says; a command aimed at another repo, by a leading `cd` or by the hook's cwd, passes. `git -C <path>` is not read.
- Claude Code PostToolUse and Stop hooks: `.claude/hooks/format-on-edit.ts` applies oxlint's safe fixes to each edited file, formats it and never blocks; `.claude/hooks/stop-gates.ts` runs `scripts/run-gates.ts` at the end of a turn that edited the repo and blocks while a gate is red, once per verdict when nothing was edited since the last block. Contract and ceilings: `.claude/rules/hook-ladder.md`.

## CI

Triggers on `pull_request` to `main`/`dev` (opened, synchronize, reopened, labeled), on `push` to `dev` and `main`, and on `workflow_dispatch`. `main` is in the push list as a backstop: a ref update reaching it outside the release path still gets validated. The guard checks that `main` is an ancestor of `dev` (`git merge-base --is-ancestor`): `main` must always be a fast-forward prefix of `dev`.

Three jobs, following the table of [Which suite runs on which trigger](#which-suite-runs-on-which-trigger). `validate` is the ladder above, and the one `scripts/check-lint-config.ts` reads for parity: it runs on every event, any label included, with no `if:`. A job its `if:` skips reports success to a required check (GitHub's [Troubleshooting required status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)), and `main` requires `validate` ([GitHub branch protections](protections.md)): a skipped `validate` beside a red one could hide it, where a real run per label costs under a minute. `e2e` runs vellum's browser suite (`bun run --cwd vellum e2e`) after Playwright installs its Chromium with the runner's system libraries (`playwright install --with-deps`, which wants root: locally, `bun run --cwd vellum e2e:install` installs the browser alone), on request only. No hook runs the suite: it takes seconds per file, and `pre-push` already runs every gate. `unlabel` takes the `e2e` label off the pull request as that run starts, so the label asks for one run and the next request is a new label. The workflow's token reads contents only; `unlabel` alone gets `pull-requests: write`, and a re-run of the same run skips it, the label being gone already.

A job its `if:` skips still leaves a check run on the SHA, concluded `skipped`: most SHAs carry a `skipped` `e2e` and a `skipped` `unlabel`; the e2e gate reads a `skipped` `e2e` as no run.

The two requests:

- The `e2e` label on a pull request whose head is in this repository: `gh pr edit <branch> --add-label e2e`. It runs `validate` and `e2e` on the pull request's head. On a fork's pull request it runs `validate` alone, as any other label does: the fork's run gets a read-only token, which cannot take the label off.
- `gh workflow run ci.yml --ref <branch>`, on any ref: `validate` and `e2e`. GitHub reads the `workflow_dispatch` trigger from the default branch's `ci.yml`, so it answers once a release has carried it to `main`. Its checks stay out of a pull request's checks list, but they are check runs on the ref's head, which is what the e2e gate reads.

## Which suite runs on which trigger

Decided in #168. `e2e` runs on request, no longer on every push. A local gate on the push to `dev` keeps a change to the browser suite's paths from landing untested.

| Trigger | `validate` | `e2e` |
|---|---|---|
| PR push, any commit | yes | no |
| Push to `dev` | yes, never cancelled | no |
| Push to `main` | yes, the backstop | no |
| One-shot `e2e` label on a PR | yes | yes, five windows; the workflow removes the label |
| Any other label on a PR | yes, never skipped | no |
| `workflow_dispatch`, any ref | yes | yes, five windows |

The table holds ([CI](#ci)), and so does the gate below; the `workflow_dispatch` row answers once a release has carried `ci.yml` to `main`. Each change is its own issue, and each brings this section to the present tense when it lands:

- #192, first, landed: the gate below, the landing order in [Git procedures](git.md), and the inline-lane rule in `AGENTS.md`.
- #193, after #192, landed: the triggers of the table, and the gate's refusal naming the label. In that order, there was never a window with no e2e at all.
- #194: one job per window (`--project=<window>`), behind one aggregate check still named `e2e`, the one the gate reads. It measures the matrix's wall time.
- #195: the fixed cost each test pays, measured, then cut.
- #196: `labels.e2e.ts` "a mockup's element by its label" timed out at `light-1024` in run 35831750016, which turned `dev` red at 38298fb. It is a finding of this work, not part of the decision.

The gate:

- A push to `dev` whose range touches the e2e paths needs a green `e2e` check on the exact SHA it pushes. The `pre-push` script `scripts/check-e2e-green.ts` refuses it otherwise ([Local enforcement](#local-enforcement)), and reads the SHA's check runs through `gh api`. It fails closed, with the reason and the command that triggers a run. `--no-verify` is the recovery hatch; `LEFTHOOK=0` skips it too, with every other lefthook job. It is no `EXPECTED_COMMANDS` entry: it needs the network and a run that already happened.
- The e2e paths have one owner, the gate script. They cover `vellum/**`, `docs/plugin-testing.md` (cited by the fixtures, asserted by `labels.e2e.ts`), `mise.toml` and `.github/workflows/ci.yml`. They leave out what the suite never loads: `vellum/src/core/engine/**`, `vellum/src/extensions/*/engine.ts`, `vellum/hooks/`, `vellum/skills/`, `vellum/agents/`, `*.spec.ts` and `*.test.ts`. A new directory under `vellum/` is inside by default. Of the 120 commits in `3850659^..947e49c`, 48 touch none of these paths.
- Landing: the rebased branch is pushed first, the `e2e` label on its pull request runs `e2e` on that SHA, which turns green, then `git push origin <branch>:dev`, the order [Git procedures](git.md) gives. A commit that touches the e2e paths goes through a branch, not the inline lane: the check needs a pushed ref to run on.

Why:

- The cost. Run 35834032446 (push to `dev`, 947e49c) took 803 s for `e2e`, 767 s of it the suite (`Running 620 tests using 2 workers`, `612 passed (12.8m)`), and 57 s for `validate`.
- The reruns. A merge train runs `e2e` twice per landing, once on the PR sync and once on the `dev` push (#168, comment on runs #359–#370). A release runs it again on a SHA already tested: 947e49c ran in 35834032446 (`dev`) and again in 35834555129 (`main`, 823 s).
- The time goes per test, not per window. In 35834032446 the median test took 2.3 s, and a short one takes as long, since each test starts its own `preview.ts` (`vellum/e2e/harness.ts`). Each window's results span 148 to 153 s on 2 workers, after 31 s of setup: that is the matrix's estimate, which #194 replaces with a measurement.
- No `concurrency` group. `e2e` runs only on request, and a new request must never kill a running one. `validate` must finish on every `dev` head, since [Git procedures](git.md) Release releases only a green one.
- `e2e` stays non-required on `main`: with the gate, every landed SHA that touched the e2e paths was already tested.

Rejected:

- `--only-changed`: Playwright follows the test files' imports, and those never reach the spawned server or the page bundle.
- Caching the browser: Playwright's CI guide advises against it, and the install took 23 s in 35834032446.
- A required check on `dev`: it would block the inline lane, and every SHA whose range the path list skips.
- A merge queue: GitHub rewrites the commits, which strips their signatures ([Git procedures](git.md), Why fast-forward).
- A filter per zone: `core/page`, `core/server` and the markdown rendering are loaded by every test file.
- Fewer windows: the matrix takes away the wall-time reason to drop any.
