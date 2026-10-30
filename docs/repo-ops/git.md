# Git procedures

[Repo operations index](../repo-ops.md). Read before a push, landing or release. The branch model and lane choice live in `AGENTS.md`.

## Fast-forward flow

`main` is a delayed pointer on `dev`'s history, never a divergent branch. `origin/dev` is the source of truth; local `dev` checkouts are caches.

- Inline work on `dev`: `git pull --ff-only` first, commit, `git push origin dev` when validated; on rejection `git pull --rebase`, push again. A commit that touches the e2e paths takes a branch instead: the pre-push hook refuses it on `dev` without a green `e2e` run on its SHA.
- Land a branch: `bun ./scripts/land.ts <branch>`, run once in the background, its pull request open against `dev`. It lands from the clean checkout holding the branch, fast-forwarded first when it is behind the pull request's head; with none, it adds one under `.claude/worktrees/land-<branch>`, installs its lockfile and removes it at the end. It waits for CI by itself, starts the `e2e` run when the branch needs one, rebases, pushes to `dev` and deletes the remote branch. It ends on one line: `landed …`, or `land: <why>`, which names what to do next. Write no CI wait, `e2e` label or `gh run watch` around it. Never use GitHub's merge button for a single branch: a GitHub-side rebase strips the signatures.
- Tier: `land.ts` runs `origin/dev`'s `scripts/tier.ts` on each `feature/` or `fix/` branch, before and after the wait for CI, and labels the pull request `tier:low` or `tier:human`. A `tier:human` one lands only with a `land-ok` label given to its change: the human types `land #<n>` in a session, then the agent adds it, which the agent-hooks guard allows only on those words. The head GitHub held when the label was added, read from its push times, must have the patch of the head that lands; a push with another patch voids the label, a rebase that keeps the patch does not. A `tier:low` one without `land-ok` is refused while a `red-dev` issue is open. Renovate's branches and `chore/claude-code-types` are not tiered.
- Tier calibration: `bun ./scripts/tier.ts --history 100` tiers `dev`'s last 100 commits, version bumps aside; `bun ./scripts/tier.ts --eval scripts/tier.cases.json` judges each case three times and prints the agreement, the false lows and the rule-of-three bound. Haiku answers only with the model and the prompt digest `tier.cases.json` names; a change to either sends every change past the floor to `human` until a run with 0 false lows records them.
- Review verdict: a branch that changes a path of `profile.review.risky` (`.claude/agent-hooks.jsonc`, read from `origin/dev`) lands only with a clean review verdict for its patch. After a `/code-review <number>` that leaves no finding open, run `bun ./scripts/review-verdict.ts record <branch> --sha <reviewed head>`. A commit after the review voids the verdict; `land.ts`'s refusal says what to redo.
- Renovate: a non-major update off the e2e and risky paths automerges once 3 days old (`renovate.json`). A session start in the main checkout runs `scripts/renovate-agent.ts` at most once a day for the others, and notifies what needs the human. `bun ./scripts/renovate-agent.ts run --dry-run` prints who owns each open pull request.
- Land a stack (`gh stack`): `gh stack merge <stack-number> --squash --yes`, once every layer is reviewed. A stacked pull request gets no `pull_request` run: run `gh workflow run ci.yml --ref <layer-branch>` on each layer's final head and wait for green, then check `git merge-base --is-ancestor origin/dev origin/<top-branch>`; when it fails, `gh stack rebase`, `gh stack push` and dispatch again. The merge runs on the server, so the pre-push `e2e` gate never sees it: hold it by hand.
- After a landing: plugin sessions pick it up by themselves ([Managed catalog](../plugin-testing/catalog.md)). Refresh a local `dev` with `git pull --ff-only`; never land through a local `dev` that might be stale.
- Clean up: the `git-sweep:auto-sweep` skill, which a session start in the main checkout also runs once a day. Agents never type `git branch -D`, `git worktree remove` or `git push --delete` for this.
- Issue footers: `Closes #N` fires on `main` (the default branch), not on `dev`.
- Force pushes happen only on feature branches (`--force-with-lease` after a rebase), never on `dev` or `main`.

## Release

The human's step: `bun ./scripts/release.ts --dry-run`, read its plan, then `bun ./scripts/release.ts --plan <digest>` with the digest it printed. It bumps each plugin changed since `main`, pushes the bumps to `dev`, waits for CI, fast-forwards `main` and tags. A failure names what to fix and leaves `main` unmoved. The pre-push hook refuses a push to `main` that leaves a changed plugin unbumped.

## Sampled review

`bun ./scripts/sample-review.ts`, after a `git fetch origin`: 3 commits landed on `origin/dev` in the last complete ISO week (`--week <YYYY-Www>`, `--count <n>`), weighted by their code lines, each with its `/code-review` command. It reviews nothing itself.

## Friction report

`bun ./scripts/friction-report.ts`, after a `git fetch origin`, on the workstation only: the week's frictions of the agent workflow, each beside the audit's average per 7 days (`BASELINE` in the script).

## Why fast-forward

Merge commits on `main` accumulated as an ever-growing ladder `dev` never received, and GitHub's rebase-merge re-creates commits unsigned, which once severed the `main`/`dev` common ancestor. Local rebase plus fast-forward push keeps one linear signed history where `main` is a prefix of `dev` by construction.
