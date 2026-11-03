# Git procedures

[Repo operations index](../repo-ops.md). Read before a push, landing or release. The branch model and lane choice live in `AGENTS.md`.

## Fast-forward flow

`main` is a delayed pointer on `dev`'s history, never a divergent branch. `origin/dev` is the source of truth; local `dev` checkouts are caches.

- Inline work on `dev`: `git pull --ff-only` first, commit, `git push origin dev` when validated; on rejection `git pull --rebase`, push again. A commit that touches the e2e paths takes a branch instead: the pre-push hook refuses it on `dev` without a green `e2e` run on its SHA. The pre-push hook also refuses it while a landing holds the landing lock: push again once that landing ends.
- Land a branch: `bun ./scripts/land.ts <branch>` or `bun ./scripts/land.ts <pull request number>`, run once in the background, its pull request open against `dev`. `--dry-run` first runs every check that comes before the lock, writes nothing, reads the tier from the `tier:` label, prints what it would do and exits 0, or 1 on the first refusal; a `tier:human` pull request that waits for the human's `/land` is named in the plan, not refused, so the plan shows every other check. It lands from the clean checkout holding the branch, fast-forwarded first when it is behind the pull request's head; with none, it adds one under `.claude/worktrees/land-<branch>`, installs its lockfile and removes it at the end. Before any wait it refuses a branch that its tier or a missing review verdict holds back. It waits for CI by itself, starts the `e2e` run when the branch needs one, rebases, pushes to `dev` and deletes the remote branch. It ends on one line: `landed …`, or `land: <why>`, which names what to do next. Write no CI wait, `e2e` label or `gh run watch` around it. Never use GitHub's merge button for a single branch: a GitHub-side rebase strips the signatures.
- Landing lock: one landing at a time on this machine. Past its checks, `land.ts` takes an exclusive flock on `~/.cache/claude-code-plugins/landing/<sha1 of origin's push URL>.lock`, shared by every checkout and worktree, waits for it an hour at most, and holds it to the end; the `.json` beside it names the holder's pid, branch and start. Meanwhile the pre-push hook (`scripts/landing/lock-check.ts`) refuses any other push to `dev` from this machine, naming the holder. The kernel drops the lock when its holder ends, however it ends: the flock decides, so a `.json` a killed landing left behind names nobody and needs no cleanup. Renovate's branch automerge pushes to `dev` from GitHub, outside the lock: a landing it overtakes rebases again or says to land again.
- Tier: `land.ts` runs `origin/dev`'s `scripts/landing/tier.ts` on each `feature/` or `fix/` branch, before and after the wait for CI, and labels the pull request `tier:low` or `tier:human`. A `tier:human` one lands only with a `land-ok` label given to its change: the human types `/land <n>` in a session (`.claude/skills/land`, which only the human can run), and before the command reaches the agent, agent-hooks' UserPromptExpansion handler, which runs on the human's typing alone, puts `land-ok` on each pull request `<n>` lands (`scripts/landing/stack.ts resolve`), then the agent runs `land.ts <n>`. The agent never adds `land-ok`: the agent-hooks guard refuses it. Where the handler gives no `agent-hooks: land-ok is on …` line (a session without agent-hooks, Claude Desktop where it is not measured), the human puts `land-ok` on GitHub themselves: `land.ts` reads when the label went on, not who put it. A refusal in a stack names the stack's number, or its top's, the `/land` that lands every layer. The head GitHub held when the label was added, read from its push times, must have the patch of the head that lands; a push with another patch voids the label, a rebase that keeps the patch does not. `land.ts` takes a voided `land-ok` off and comments the commits since the head it covered, each linked, with GitHub's compare view of the two heads when no rebase came between: the human reads those alone, then types `/land <n>` again, which takes a `land-ok` still on the pull request off before adding it, since GitHub dates no event for a label added twice. A `tier:low` one without `land-ok` is refused while a `red-dev` issue is open. Renovate's branches and `chore/claude-code-types` are not tiered.
- Tier calibration: `bun ./scripts/landing/tier.ts --history 100` tiers `dev`'s last 100 commits, version bumps aside; `bun ./scripts/landing/tier.ts --eval scripts/landing/tier.cases.json` reads each case three times, or once when the floor decides it, and prints the agreement, the false lows and the rule-of-three bound over the cases marked `heldOut` that the model judged, `heldOut` marking the ones judged only after the prompt's last revision; it exits 1 on a false low, a failure, or a `low` case read `human` on every run. Haiku answers only with the model and the prompt digest `tier.cases.json` names; a change to either sends every change past the floor to `human` until a run that exits 0 records them.
- Review verdict: a branch that changes a path of `profile.review.risky` (`.claude/agent-hooks.jsonc`, read from `origin/dev`) lands only with a clean review verdict for its patch against its pull request's base. After a `/code-review <number>` that leaves no finding open, run `bun ./scripts/landing/review-verdict.ts record <branch> --sha <reviewed head>`, before `land.ts`: it reads the verdict before the wait for CI. A commit after the review voids the verdict; `land.ts`'s refusal says what to redo.
- Renovate: a non-major update off the e2e and risky paths automerges once 3 days old (`renovate.json`). A session start in the main checkout runs `scripts/headless/renovate-agent.ts` at most once a day for the others, and notifies what needs the human. `bun ./scripts/headless/renovate-agent.ts run --dry-run` prints who owns each open pull request. Once an update lands, the leads pipeline reads what it brings and files leads for the human to sort ([Leads pipeline](leads.md)).
- Land a stack: `bun ./scripts/land.ts <stack number>`, or the number of a layer, which lands it with the layers under it, run once in the background. Every layer lands with its own commits, signed, as for a branch; never `gh stack merge`, whose server-side merge strips the signatures. Before any wait it checks each layer against its own base, bottom to top, and refuses a top that does not hold `origin/dev`: run `gh stack rebase`, then `gh stack push`, then land again. It dispatches one `ci.yml` run on the top's head, every job and `e2e` included, or waits for the one already there, then pushes `dev` and every lower branch to the top in one atomic push, which GitHub reads as every layer merged, and deletes the remote branches; a layer above the one named keeps its base branch.
- Landing worker: `bun ./scripts/land.ts --worker --once` is one pass that lands without a session what carries `land-ok` or `tier:low` (`scripts/landing/worker.ts`). It reads every open pull request and lands, by number and one at a time, each stack only whole: a line of open pull requests from `dev` up, each based on the one under it, a single pull request being a line of one, whose every layer is a `feature/` or `fix/` branch, headed by that open pull request alone, carrying `land-ok`, or `tier:low` outside a draft and `needs-human`. Each lands through `land.ts <top>`, a run of its own, under the landing lock, killed past 3 h. A stack with any other layer, a voided one included, or that forks, waits for the human's `/land` in a session: landed in part, it would leave a layer based on a merged branch. A pull request labelled within the last quarter of an hour is left to the landing that labelled it, and a pass ends while a landing holds the lock. A target whose head, tier labels and `land-ok` date are those its last run left waits an hour after a new refusal, twice as long after each repeat of it, the run it names aside, four hours at most: a red run is not re-run every five minutes, and a target held by a red `dev` is tried again. A pull request whose head does not hold `origin/dev` lands only when commits can be signed here; otherwise the worker comments `landing-worker: a rebase needs your signature: land it from a session`, once per head. One worker runs at a time. Each pass prints one line per target; `~/.cache/claude-code-plugins/landing/worker.log` keeps each landing's whole output, and `worker.json` beside it is the memo, each pull request named by its repository and number: remove it to forget. A user systemd timer runs it every five minutes on the workstation; the human installs both units, kept in the dotfiles:

  ```ini
  # ~/.config/systemd/user/landing-worker.service
  [Unit]
  Description=Land on dev what carries land-ok or tier:low (claude-code-plugins)

  [Service]
  Type=oneshot
  WorkingDirectory=%h/Work/claude-code-plugins
  Environment=PATH=%h/.local/share/mise/shims:%h/.local/bin:/usr/local/bin:/usr/bin
  Environment=SSH_AUTH_SOCK=%t/ssh-agent.socket
  ExecStart=%h/.local/share/mise/shims/bun ./scripts/land.ts --worker --once
  ```

  ```ini
  # ~/.config/systemd/user/landing-worker.timer
  [Unit]
  Description=Run the landing worker every five minutes

  [Timer]
  OnBootSec=2min
  OnCalendar=*:0/5

  [Install]
  WantedBy=timers.target
  ```

  `WorkingDirectory` is the main checkout. The pushes go over SSH, through the agent socket the session sets (`%t` is `/run/user/<uid>`), and the commits are signed by the gpg agent, which the service reaches by its own socket. A passphrase the agent no longer holds either fails the rebase, which the landing names in the log, or opens a pinentry that waits until the landing is killed at 3 h; which of the two happens under the unit is not measured. Start it with `systemctl --user enable --now landing-worker.timer`, stop it with `systemctl --user stop landing-worker.timer`, and read its passes with `journalctl --user -u landing-worker`.
- After a landing: plugin sessions pick it up by themselves ([Managed catalog](../plugin-testing/catalog.md)). Refresh a local `dev` with `git pull --ff-only`; never land through a local `dev` that might be stale.
- Clean up: the `git-sweep:auto-sweep` skill, which a session start in the main checkout also runs once a day. Agents never type `git branch -D`, `git worktree remove` or `git push --delete` for this.
- Issue footers: `Closes #N` fires on `main` (the default branch), not on `dev`.
- Force pushes happen only on feature branches (`--force-with-lease` after a rebase), never on `dev` or `main`.

## Release

The human's step: `bun ./scripts/release.ts --dry-run`, read its plan, then `bun ./scripts/release.ts --plan <digest>` with the digest it printed. It bumps each plugin changed since `main`, pushes the bumps to `dev`, waits for CI, fast-forwards `main` and tags. A failure names what to fix and leaves `main` unmoved. The pre-push hook refuses a push to `main` that leaves a changed plugin unbumped.

## Sampled review

`bun ./scripts/reports/sample-review.ts`, after a `git fetch origin`: 3 commits landed on `origin/dev` in the last complete ISO week (`--week <YYYY-Www>`, `--count <n>`), weighted by their code lines, each with its `/code-review` command. It reviews nothing itself.

## Friction report

`bun ./scripts/reports/friction-report.ts`, after a `git fetch origin`, on the workstation only: the week's frictions of the agent workflow, each beside the audit's average per 7 days (`BASELINE` in the script).

## Why fast-forward

Merge commits on `main` accumulated as an ever-growing ladder `dev` never received, and GitHub's rebase-merge re-creates commits unsigned, which once severed the `main`/`dev` common ancestor. Local rebase plus fast-forward push keeps one linear signed history where `main` is a prefix of `dev` by construction.
