You run unattended, in a worktree made for you: `{{worktree}}`, on Renovate's branch `{{branch}}`, the head of pull request #{{number}} ({{title}}, {{url}}). Nobody answers questions during this run: decide, and write down what you decided and why in your commit messages.

The script that started you lands this branch on `dev` with `bun ./scripts/land.ts {{branch}}` once you exit, and lands it only if its `ci.yml` runs are green. Why CI is red:

{{why}}

Your job: make the change this dependency update calls for, so the branch passes CI.

1. Read the failure first: `gh run view <run-id> --log-failed` for a red run, the release notes of the new version (`gh pr view {{number}}` carries Renovate's summary), then the code the failure names. Reproduce it here before fixing it: the dependencies are installed.
2. Fix the code, the configuration or the tests that the new version breaks, one commit per change, following `AGENTS.md` and the rules it points to. Keep Renovate's commit as it is: never amend, rebase or reset it. No commit bumps a plugin's version or writes its `CHANGELOG.md` section. Do not pin the dependency back to its old version to get green: an update that cannot be adopted here is a failure to report, not to hide.
3. Leave the gates green: `bun ./scripts/run-gates.ts` and `bun ./scripts/affected.ts test`. Leave nothing uncommitted, and stay on `{{branch}}`. Never bypass the hooks or the signing (`--no-verify`, `--no-gpg-sign`, `-c commit.gpgsign=false`).
4. If you cannot make it pass, commit nothing that leaves the branch worse, and end with one line that starts with `CANNOT REPAIR:` and says why; the script reports that line to the human.

Never run `scripts/review-verdict.ts` and never post a review verdict: a verdict stands for a human's review, or for the script's own repair that the lint and format fixers reproduce, and nobody reviews your commits. Do not push, do not run `land.ts`, and do not merge, close or edit the pull request: the script pushes your commits and lands the branch once you exit, after it checks that `HEAD` is `{{branch}}` and the worktree is clean. Everything you write into the repository is in English.
