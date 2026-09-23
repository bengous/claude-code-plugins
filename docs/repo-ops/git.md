# Git procedures

[Repo operations index](../repo-ops.md). Read before a push, landing or release. The branch model and lane choice live in `AGENTS.md`.

## Fast-forward flow

`main` is a delayed pointer on `dev`'s history, never a divergent branch. `origin/dev` is the source of truth; local `dev` checkouts are caches:

- Land a branch (remote-first, once, when validated): `git fetch origin`, `git rebase origin/dev`, `git push --force-with-lease origin <branch>`, then `git push origin <branch>:dev` — from any checkout or worktree. When the branch touches the e2e paths, wait between the two pushes until the `e2e` check of the pushed head is green (`gh pr checks <branch> --watch`): the pre-push hook refuses the push to `dev` while that SHA has no green `e2e` run ([Local checks](checks.md)). A rejected push to `dev` means `origin/dev` moved in between: repeat from the fetch, which makes a new SHA and a new run; the loop converges because the branch is finished. GitHub marks the PR merged because the reviewed head SHA reaches the base; a rebase after the last reviewed push of the branch breaks that detection — then `gh pr close` with the integration SHA. The GitHub merge button is never used; rebasing locally keeps commits signed by the author's key (GitHub-side rebase would strip signatures and trip `Require signed commits`).
- Plugin sessions after a landing: once the catalog units are activated, `claude-plugin-catalog.path` watches the `origin/dev` reflog and runs `scripts/plugin-catalog.ts sync` from the locked catalog worktree. No pull or plugin update is needed for sessions. This does not refresh a local `dev` checkout. Setup, recovery and the pending live verification are in [Managed catalog](../plugin-testing/catalog.md).
- Refresh a stale local `dev` after a landing: `git pull --ff-only` from the checkout holding `dev`. Never land through a local `dev` that might be stale — that is how a fast-forward publish turns into a rejected push and a hand-recovered rebase.
- Inline work on `dev`: `git pull --ff-only` first, commit, `git push origin dev` when validated; on rejection `git pull --rebase`, push again. A commit that touches the e2e paths takes a branch instead: the pre-push hook refuses it on `dev` without a green `e2e` run on its SHA.
- Issue footers: `Closes #N` fires on `main` (the default branch), not on `dev`. Issues referencing landed commits stay open until the release push, or are closed by hand with the SHA.
- Release: `git push origin dev:main`, once the head's `validate` run is green and the human has emptied, or accepted item by item, what the landed PRs list as not measured. The pre-push hook refuses it while a marketplace plugin changed since the remote's `main` and kept its `plugin.json` version, and names each one (`scripts/check-plugin-bumps.ts`, [Local checks](checks.md)): bump each in a `chore(<plugin>): X.Y.Z` commit on `dev` first. After `git fetch origin`, `bun ./scripts/check-plugin-bumps.ts origin/main origin/dev` lists them ahead of the push. CI runs on push heads only, so the releasable commits are exactly the SHAs that were once a pushed `dev` head; with a red head, either release the last green SHA (`git push origin <sha>:main`) or land a fix commit and release that. The rulesets guarantee this is the only kind of push `main` accepts.
- Force pushes happen only on feature branches (`--force-with-lease` after a rebase), never on `dev` or `main`.

## Why fast-forward

Merge commits on `main` accumulated as an ever-growing ladder `dev` never received, and GitHub's rebase-merge re-creates commits unsigned, which once severed the `main`/`dev` common ancestor. Local rebase plus fast-forward push keeps one linear signed history where `main` is a prefix of `dev` by construction.
