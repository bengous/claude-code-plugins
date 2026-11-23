# Git procedures

[Repo operations index](../repo-ops.md). Read before a push, a pull request or a release. The branch model lives in `AGENTS.md`, the rules a pull request follows in `CLAUDE.md`, and the factory's loop in `factory/README.md`.

## How a change reaches dev

`dev` is the default branch and the trunk; `main` is a delayed pointer on its history, never a divergent branch. `origin/dev` is the source of truth; local `dev` checkouts are caches.

- No direct push: the ruleset of `dev` refuses one from anyone. A change is a pull request against `dev`, which GitHub's auto-merge squashes into one commit once `test`, `review` and `owner-gate` are green and its review threads are resolved. That commit's subject is the pull request's title, its body is empty, and GitHub signs it.
- From an issue: the owner labels his issue `ready`; `dispatch.yml` fires the routine, and a cloud session implements the issue, runs the `verify` skill and opens the pull request with auto-merge on. The session follows it until it merges: a finding of the review, a red `test` or a failed `conflict` status wakes it.
- From a session on the owner's machine: a branch from `origin/dev`, pushed, `github-flow:pr`, then `gh pr merge <n> --auto --squash`. Write no CI wait or `gh run watch` around it: the pull request merges by itself.
- Tier: `owner-gate.yml` runs `dev`'s `.github/factory/tier.ts` on the head commit. A floor decides first: a path of `.github/CODEOWNERS`, a path or the line cap of `.github/factory/tier.json`. Past it, Claude Haiku reads the diff under `tier-prompt.md`. The labels `tier:low` and `tier:human` show the result; no check reads them. A `tier:human` pull request merges only once the owner adds `human-approved` by hand, which approves that head alone: any push removes it. No agent adds it: `.claude/hooks/guard-owner-labels.ts` denies a session on the owner's machine the command ([GitHub branch protections](protections.md)).
- Tier calibration: `bun .github/factory/tier.ts replay --repo bengous/claude-code-plugins` judges each case of `tier-cases.json` three times and prints the agreement and every false `low`; `--record` writes the model and the prompt's digest a clean run validated. The classifier answers only for the prompt its cases validated: after an edit of `tier-prompt.md`, every change past the floor is `human` until a `--record`.
- Review: `review.yml` runs `.claude/commands/pr-review.md` on each push, at a higher effort and with `--deep` on a path of `.github/deep-review-paths`. It fails while it has a finding. At the third commit on which `review` or `test` failed, or at a force-push other than Renovate's own, it labels the pull request `needs-human`, and its session stops until the owner comments what to do and removes the label.
- Conflict: `conflict.yml` sets a failed `conflict` status on a pull request that conflicts with `dev`; its session merges `dev` into the branch. A pull request's branch is never rebased.
- A red `dev`: `trunk-red.yml` opens a `trunk-red` issue and fires the routine on it. After two repairs that leave `dev` red, the next issue is `needs-human` and no session starts.
- A stack (`github-flow:stacked-prs`) lands one layer at a time. The gate judges a pull request based on `dev` alone: a layer above it stays red on `owner-gate` and `review` until its base is `dev`, and a push then runs them. Bring `dev` into that layer with a merge and push it with `git push`: `gh stack rebase` and `gh stack sync` rewrite every layer, a rewritten layer goes up as a force-push, from `gh stack push` and `gh stack submit` too, and a force-push stops the pull request. `gh stack merge` needs every layer green at once. Whether GitHub moves a layer's base to `dev` when the branch under it is deleted at its merge is not measured here.
- Renovate: `renovate.json` opens one pull request per update against `dev`, GitHub's auto-merge on, a major aside, which carries the label `major` and waits for the owner. The gate judges it as any other pull request; `review.yml` names `renovate` in `allowed_bots`, without which the review action refuses a bot's pull request. No session follows a Renovate pull request: one that stays red waits for the owner, who hands it to the factory with an issue. Once an update lands, the leads pipeline reads what it brings and files leads for the human to sort ([Leads pipeline](leads.md)).
- Claude Code's types: `scripts/headless/claude-code-types.ts` opens the pull request of `chore/claude-code-types` with auto-merge on ([Hooks](../plugin-testing/hooks.md)).
- After a merge: plugin sessions pick it up by themselves ([Managed catalog](../plugin-testing/catalog.md)). Refresh a local `dev` with `git pull --ff-only`.
- Clean up: GitHub deletes a pull request's branch at its merge. Local branches and worktrees are the `git-sweep:auto-sweep` skill's, which a session start in the main checkout also runs once a day. Agents never type `git branch -D`, `git worktree remove` or `git push --delete` for this.
- Issue footers: `Closes #N` fires at the merge into `dev`, the default branch.
- Force pushes never happen on `dev` or on `main`, and no session force-pushes a branch whose pull request is open. Two writers do: Renovate, which rewrites its own branches and which `review.yml` leaves out of its count, and the types pipeline when its live branch conflicts with `dev`, a force-push that stops its pull request.
- What the factory lacks on GitHub, a label, a secret, a rule of the ruleset: `bun ./factory/scripts/check.ts --repo bengous/claude-code-plugins` prints it, one line per item with its fix.

## Release

The human's step: `bun ./scripts/release.ts --dry-run`, read its plan, then `bun ./scripts/release.ts --plan <digest>` with the digest it printed. It bumps each plugin changed since `main` in one commit on `dev`'s head, pushes it to `release/<target>`, opens a pull request against `dev` whose body names the plan's digest and that commit, and prints its URL. Add the label `human-approved` to it yourself: it is your approval of that head, and the script never adds it. The script waits up to an hour until GitHub calls the pull request mergeable (your label on, the required checks green), checks `dev`'s head against the plan, then squash-merges the commit it pushed itself, and no other head (`gh pr merge --squash --match-head-commit`). GitHub's squash commit, titled `chore(release): <plugin>@x.y.z, ...` with the pull request's number, sets every bumped version and carries every tag. Then it waits for CI on that commit, fast-forwards `main` and tags. Every stop names what to do, with `main` unmoved:

- The timeout: once the label is on and the required checks are green, the same `--plan <digest>` run again finds its pull request and resumes the wait.
- A red check, judged by its latest run: a `review` red on its own found something, and running it again gives the same verdict; read its comments. A red job that is flaky, the reviewer's own `review (read)` among them: re-run it (`gh run rerun <run-id> --failed`), then run the same `--plan <digest>` again. A fix, for a review finding or a real failure, lands on `dev` on its own pull request, never on the release branch: the script refuses a head it did not push. Then close the release pull request and run the dry-run again.
- A conflict with `dev`, a head the script did not push, or `dev` gaining a commit the plan does not cover (under a plugin it bumps, a plugin that now needs a bump, a new tag) or `main` moving: nothing is merged. Close the pull request (`gh pr close <n> --delete-branch --comment <why>`) and run the dry-run again.
- A merge call that fails, or whose result does not read back: the bumps may already be on `dev`. The same `--plan <digest>` finds the pull request merged and carries on from its commit, or resumes the wait if it did not merge.
- The release branch holding a commit that is the head of no closed pull request (another run of the plan may be opening its own): nothing is pushed. Run the same `--plan <digest>` again once that pull request is open, or delete the branch (`git push origin --delete release/<target>`) when nothing uses it.
- `dev` gaining such a commit between that check and the merge: the release commit is on `dev` and `main` unmoved. Revert it on `dev` through a pull request, then run the dry-run again: the revert resets the versions, so the next plan judges everything.

The pre-push hook refuses a push to `main` that leaves a changed plugin unbumped.

## Sampled review

`bun ./scripts/reports/sample-review.ts`, after a `git fetch origin`: 3 commits landed on `origin/dev` in the last complete ISO week (`--week <YYYY-Www>`, `--count <n>`), weighted by their code lines, each with its `/code-review` command. It reviews nothing itself.

## Friction report

`bun ./scripts/reports/friction-report.ts`, after a `git fetch origin`, on the workstation only: the week's frictions of the agent workflow, each beside the audit's average per 7 days (`BASELINE` in the script).

## Why squash, then fast-forward

`dev` takes one commit per pull request, which GitHub signs: its rebase-merge re-creates each commit unsigned, and the linear-history rule refuses a merge commit. `main` moves by fast-forward alone, so it is a prefix of `dev` by construction, which CI's `validate` checks on every run.
