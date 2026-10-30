# GitHub Flow Plugin

GitHub lifecycle for Claude Code through `gh`: agent-ready issues, review-ready PRs, issue and PR triage, CI-gated merge.

## Skills

| Skill | Invocation | What it does |
|-------|------------|--------------|
| `issue` | `/github-flow:issue [--dry-run] [number] <request>` | Writes or rewrites an issue as a prompt for another agent: Problem, Evidence, Hints, Done when, Out of scope. |
| `pr` | `/github-flow:pr [--dry-run] [image.png#alt ...] [notes]` | Settles the branch's open decisions, reviews it, pushes it and opens or updates its PR with a body that shows the change first: a diagram, a tree diff, a table or screenshots; images go up through `gh --attach`. Labels the PR with its review tier. |
| `triage` | `/github-flow:triage [--dry-run] [number\|url]` | Verifies an issue or PR against the current code, gives a one-word verdict with proof, then closes or comments as the verdict fixes; valid work is reported, not implemented. Manual. |
| `await-merge` | `/github-flow:await-merge [--dry-run] [--rebase] [pr]` | Watches the checks, merges by squash (`--rebase` for atomic commits, never a merge commit), fast-forwards the local base branch. |
| `commit-push-pr` | `/github-flow:commit-push-pr [issue] [images] [notes]` | Chains `git:commit` then `github-flow:pr`. |
| `stacked-prs` | `/github-flow:stacked-prs [subcommand \| symptom]` | Runs a stack of PRs with `gh stack`: the cycle, the rules the CLI does not enforce, the repair table, and a worktree per layer cut from the top of the stack with its handoff symlinked in. |
| `dispatch` | `/github-flow:dispatch <n> [<n>...] [--plan] [--approve]` | Gates each issue on readiness, then spawns one worker per issue from the worker brief; labels the outcome, reports a table. |
| `shift` | `/github-flow:shift [--max <n>] [--dry-run]` | One pass of the loop: triage, dispatch, maintain the loop's PRs, land the ones their worker left, return a digest. |

`issue`, `pr` and `stacked-prs` invoke themselves when the request matches. `triage`, `await-merge` and `commit-push-pr` run only on an explicit call: each one closes, merges or pushes, and "check issue 12" must not close issue 12. `dispatch` and `shift` stay model-invocable because a scheduled fire runs no other kind: their only push goes through the repository's landing command, gated by tier, CI and the `land-ok` label. `shift` closes an issue only through the `triage` protocol it applies itself.

No skill asks before it publishes, closes or merges: an orchestrating agent has nobody to answer. A PR body asks nothing either: with a user in the session, `pr` puts the branch's open decisions to them before publishing; without one, it settles them and writes each in *Decisions*, so a worker never blocks on a question. `--dry-run` does the whole job and prints what would be sent instead of sending it; rerun without it to send.

`github-flow` depends on the `git` plugin, installed with it.

### PR shape

Agents review the PR first; the body is for the human who opens it afterwards. It shows the change, then says only what a picture cannot:

```markdown
Closes #N.
<two lines: the problem, what the change does>
## Before / After   the views: a diagram, a tree diff, a shaped diff, a table, screenshots
## Decisions        each choice: what was kept, what was set aside, why, the line that undoes it
## Checks           the tier line; the review and its findings; commands with their numbers;
                    added tests as Test | Mutant | Seen failing
## Left open        limits, what was read but not run, what was not measured, views left out,
                    diagrams not seen rendered
```

The branch is reviewed before the body is written, so the body and the tier describe the final head: `/code-review` against the base, `plugin-dev:skill-reviewer` when a `SKILL.md` or an agent changes, and the repository's `verdict` command once no finding is open.

The view follows the kind of change: a `flowchart TB` for an architecture or a data model, a `sequenceDiagram` for behaviour over time, a tree diff for moved directories, pseudocode as a diff for logic, a call tree for runtime control flow, a component tree for UI structure, screenshots for what a user sees. A standard change gets one view, a large one (≥ 10 files, ≥ 300 lines, or a shared module) three at most. `scripts/tree-diff.ts origin/<base>` prints the tree diff: a directory moved, added or deleted whole is one line. `skills/pr/references/` holds a worked example of each view and the Mermaid traps measured on GitHub; a body with a diagram is checked in a browser that can open the PR, and without one *Left open* says so. The menu of views and some of its wording come from Dex Horthy's `show-me` and Matt Pocock's `pr`, both MIT: `skills/pr/CREDITS.md`.

A visual change carries a Before/After pair: the agent captures both states with the session's browser tool when none is given, and `gh pr create --attach './before.png#alt'` uploads them; the alt text names what the reader sees. The body ends with `<!-- opened_by: <session id> -->`, joined by `<!-- updated_by: <session id> -->` on an update, so the session behind a PR is found with `claude --resume <id>` whether or not it had a plan; inside a subagent the id is the parent session's.

### Issue shape

```markdown
## Problem      what is observed and what is wanted, no solution
## Evidence     one fact per bullet, each anchored: path:line + symbol, or a commit
## Hints        where to start, traps, boundaries; suggestions, never a plan
## Done when    observable checkboxes, including the project's validation command
## Out of scope what not to touch on the way (omitted when empty)
```

The reader is a different agent in a fresh session. The issue proves the problem; the reader plans.

### Triage verdicts

| Issue | PR |
|---|---|
| `valid`, `fixed`, `outdated`, `duplicate`, `unclear` | `mergeable`, `needs-rebase`, `superseded`, `stale`, `unclear` |

Close comments are one to three sentences of fact: what was verified and the commit, issue, or PR that settles it.

### Stacked PRs

`stacked-prs` documents `gh stack` (the `github/gh-stack` extension): one PR per layer, each based on the layer below, landed atomically bottom to top. It carries the rules the CLI leaves to the caller (branch from the top, one checkout per session, verify content after every rebase, nothing on the trunk before landing) and a repair table keyed by symptom. `scripts/worktree-handoff.ts <branch> --base origin/<top>` cuts a worktree for a parallel session: it symlinks the gitignored orchestration folder (`.gh/` by default) so the session finds its handoff and its checklist writes come back to the main checkout, adds the folder to `info/exclude`, and installs dependencies from the lockfile. The handoff template lives in `skills/stacked-prs/assets/`.

## The loop

`shift` runs one pass of an issue-to-PR loop with no human inside it. It triages the open issues, hands the ready ones to `dispatch`, keeps the pull requests the loop already opened green, and lands those their worker left behind. The human reads the digest: its *Needs you* section lists the `tier:human` PRs, and *Low escapes* the `tier:low` PRs a later fix or revert touched. Nothing in the loop merges through GitHub.

### Workers

`dispatch` reads `skills/dispatch/references/worker-brief.md`, fills its holes from the issue, the plan and the repository's `.claude/github-flow.json`, and spawns one `general-purpose` subagent per issue with the filled brief as its whole prompt, `model: opus` and `isolation: worktree` on the call, all in the same message. A brief, not a named agent: a named agent's body replaces Claude Code's own subagent prompt, and a `general-purpose` subagent finds the `git:commit` and `github-flow:pr` skills through the Skill tool. A subagent has no `AskUserQuestion`, and `pr` inside one settles its decisions instead of asking.

The brief states the outcome, not the steps: the issue's *Done when* met, the validate commands green, a PR, and for a `tier:low` PR the last line of the landing command, which the worker runs in the background and waits for. A `tier:human` PR is the human's to land. Red after two red-green rounds is `blocked`, reported with the failing output verbatim. In `fix <pr>` mode a worker repairs a PR the loop owns, pushes, runs the tier again and posts a `<!-- shift-fix -->` comment; a later `shift` lands it. A comment reaches a worker only from an account that can push to the repository.

`.claude/github-flow.json` names the repository's commands; `{pr}`, `{branch}` and `{sha}` are filled in:

```json
{
  "validate": ["bun ./scripts/run-gates.ts", "bun test --parallel"],
  "tier": "bun ./scripts/tier.ts --pr {pr}",
  "verdict": "bun ./scripts/review-verdict.ts record {branch} --sha {sha}",
  "land": "bun ./scripts/land.ts {branch}"
}
```

Without the file, the validation commands come from the repository's `AGENTS.md` or `CLAUDE.md`, every PR is `tier:human`, and the human lands it with `/github-flow:await-merge`.

### Tiers

The change sets the tier, not its author. The `tier` command prints `low <reason>` or `human <reason>`; `pr` writes the line in *Checks* and labels the PR. A `tier:low` PR lands on green checks without a human; a `tier:human` PR waits until the human types `land #<n>` in a session, and the agent then adds the `land-ok` label. The tier only goes up: a later pass may turn `tier:low` into `tier:human`, never the reverse.

In this repository, `scripts/tier.ts` decides in two steps. A floor in code sends to `human` a change touching a risky path of `.claude/agent-hooks.jsonc` or an e2e path, a breaking commit, a skill, agent, command or plugin added or removed, any change to a `hooks.json` or `.mcp.json`, or more than 400 lines. Past it, Haiku judges what could break and which automatic check would catch it; the PR's *Left open* is read only once the change alone reads low, so it may only raise the tier. `scripts/land.ts` reads the tier again with `origin/dev`'s copy at each landing, lands a `tier:human` PR only with a `land-ok` given to its change, and lands no `tier:low` PR without one while a `red-dev` issue is open. The change a `land-ok` was given to is the head GitHub held when the label was added, by its push times; a later push with another patch voids it, a rebase that keeps the patch does not. A voided `land-ok` comes off, and a comment links the commits since the head it covered, with GitHub's compare view of the two heads when no rebase came between: the human reads those alone and types `land #<n>` again, and a `fix` worker reviews that range alone. On `land #<n>`, the agent takes a `land-ok` still on the PR off before adding it: GitHub dates no event for a label added twice. The agent-hooks guard (`profile.approvals.labels`) lets an agent add `land-ok` only when the human's latest typed message says `land #<n>`.

State lives on GitHub, in labels, so a pass is idempotent:

| Label | On | Meaning |
|---|---|---|
| `needs-info` | issue | The readiness gate found no evidence or no acceptance criteria. |
| `dispatched` | issue | A worker opened its PR. |
| `blocked` | issue | A worker stopped; the failing output is a comment. |
| `shift` | PR | The loop owns this PR and maintains it. |
| `needs-human` | PR | Two fix rounds were not enough. The loop stops touching it. |
| `tier:low` | PR | Lands on green checks without a human. |
| `tier:human` | PR | Waits for the human's `land #<n>`. |
| `land-ok` | PR | The human typed `land #<n>` in a session; only the agent-hooks guard lets an agent add it. |

Three runners, one skill:

```bash
/loop /github-flow:shift
claude -p "/github-flow:shift" --permission-mode auto --max-turns 200 --max-budget-usd 5 --output-format json
/schedule /github-flow:shift
```

`/loop` re-runs the skill each iteration, in an open session, on a 1-minute-to-1-hour interval. The `-p` form suits a systemd timer: in `auto` mode a blocked action does not run and the pass continues, `--max-budget-usd` counts the workers' spend too, and both caps are print-mode only. `/schedule` puts the same prompt on the cloud, minimum interval 1 hour.

## Plans on pull requests

Three hooks carry the plan of a session to the pull request that session creates, so the plan is read where the diff is reviewed instead of in a file nobody opens.

| Hook | Event | What it does |
|---|---|---|
| `scripts/stamp-plan.ts` | `PreToolUse` on `Write` | On a Write of the harness's own plan file, `~/.claude/plans/<slug>.md`, puts the session line at the top of the content before the file is written. |
| `scripts/gate-plan.ts` | `PreToolUse` on `ExitPlanMode` | Lints the plan ([Plan lint](#plan-lint)). A plan it does not deny goes to `scripts/capture-plan.ts`, which writes it to `~/.claude/plans/by-session/<session_id>[/<agent_id>].md`, tags the harness's own plan file with the session id when it is not tagged yet, then refreshes the comment when the checkout already has a PR. |
| `scripts/attach-plan.ts` | `PostToolUse` on `Bash` | On a `gh pr create` whose output carries a `<host>/<owner>/<repo>/pull/<n>` URL, posts the session's own plan, or the plan of the session named by a marker in its transcript, on that PR of that repository. |

The key is the identity the session already has when the plan is approved: `session_id`, plus `agent_id` when the plan is approved inside a subagent. The branch is not asked for, so the worktree that does not exist yet, the `worktree-<n>` branch renamed later, and a `cd <other-checkout> && gh pr create` all change nothing; the repository comes from the PR URL, not from the session cwd, so `cd ../other-repo && gh pr create` posts on the other repository's PR. A session with no plan of its own and no planning marker in its transcript gets no comment. A dispatched worker is such a session: it never approved a plan, so its PR carries one only when the plan text in its prompt kept the `<!-- session_id: <id> -->` line, which the transcript scan then finds.

The plan file opens with `<!-- session_id: <id> -->`, which the comment carries next to the marker and GitHub renders as nothing, so the session that wrote the plan is found at `~/.claude/projects/<project>/<id>.jsonl` and resumed with `claude --resume <id>`. The harness's plan file carries that same line: `stamp-plan.ts` adds it to the Write through `updatedInput`, so the file never changes behind the agent and Claude Code has no changed-file note to send it, and capture writes it only into a plan file written without it. That file is the one re-injected by "Accept and start in a new session (fresh context)": the fresh session reads the marker in its own transcript and its PR carries the plan, with `<!-- executed_by: <id> -->` under the session line naming the session that created the PR.

The comment opens with the marker `<!-- plan -->`, followed by a `<details><summary>Plan</summary>` block. A new plan in the same session edits that comment instead of adding one: the hook lists the PR's comments and matches the first of yours whose body starts with the marker. One PR, one plan comment, whatever the number of revisions.

`PreToolUse`, not `PostToolUse`: the plan dialog's "Yes, clear context" options ([`showClearContextOnPlanAccept`](https://code.claude.com/docs/en/settings-reference#showclearcontextonplanaccept)) resolve the `ExitPlanMode` call as a denial, and `PostToolUse` runs only after a tool succeeds, so a plan approved that way would never be captured. The trade is that the plan is written before the answer: a rejected plan leaves its file behind until the next approval in that session overwrites it, and in a checkout that already has a PR, it reaches the comment.

Only the lint blocks, and it is one hook with the capture, so the plan it denies is never stored nor posted. Every hook exits 0 on every path and reports a failure on stderr, which `claude --debug` shows.

## Plan lint

`scripts/gate-plan.ts`, a `PreToolUse` hook on `ExitPlanMode`, denies a plan that `scripts/plan-lint.ts` finds fault with, and Claude reads the findings as the reason. The checks are the part of a plan review a script can decide, with no model call:

| Check | Finding |
|---|---|
| `placeholder` | A line of prose leaves a choice open: `TBD`, `TBC`, `???`, "to be decided", "decide at implementation", "à décider", "à trancher", "reste à définir". A line that hands the choice out of the plan ("out of scope", "separately", "hors de ce plan"), defers it to a later phase or milestone ("plus tard", "en phase 2", "jalon M4"), or says it is settled is not one: a phased plan details only its current phase. |
| `open-question` | An item under an "Open questions" heading names no option taken: no "I would", "default", "recommended", "je prendrais"... A section written in paragraphs counts as one question, and "None." as none. |

Code spans, fences and HTML comments are not read. `bun scripts/plan-lint.ts <plan.md>...` prints the same findings as `<file>:<line>: <check>: <message>` and exits 1 when there is one, 2 on a file it cannot read, so a plan written outside plan mode, a `vellum` plan included, is checked the same way.

Plan mode answers a denied `ExitPlanMode` with another call, so each plan is denied once. The hook keeps the digest of the last plan it denied, per session and agent, in `~/.claude/plans/lint/` beside the by-session store; the same plan submitted again, the session line aside, goes on to the user's approval in silence. The user already has the findings: the transcript shows the denial just above the plan dialog, which renders neither a hook's `systemMessage` nor an `ask` reason (CLI 2.1.301, tried live). The deny tells Claude so: revise the plan, or resubmit it unchanged when a finding is wrong. A wrong finding costs one call, and a plan that comes back clean clears the digest. Any failure lets the plan through.

Left out, for refusing good plans as often as bad ones. Measured on 2026-10-17 over the owner's transcripts: 975 distinct plans submitted to `ExitPlanMode`, 530 approved and 247 sent back with a note, hit rate on each:

| Candidate | Approved | Sent back | Why it went |
|---|---|---|---|
| `TODO`, `FIXME`, `XXX` as placeholders | 4.5% | 2.4% | The hits name work to log ("log it as TODO"), not a hole in the plan. |
| A step or slice heading with no check under it | 10.6% | 13.0% | Most plans close on one Verification section instead. |
| No check anywhere in the plan | 0.9% | 0% | Every hit is a throwaway plan of six lines. |
| Backticked names equal up to case and separators | 11.7% | 19.8% | `.x` and `x`, `runId` and `run_id`: a selector and its class, a JSON key and its field. |
| One file name under two paths | 17.2% | 23.9% | `index.ts` and `SKILL.md` live in many folders. |

The kept checks hit 0.9% of the approved plans and 3.6% of those sent back.

## Closing a pull request

A pull request integrated by squash, rebase or cherry-pick stays "closed" on GitHub, with nothing on it to say where its work went.

| Hook | Event | What it does |
|---|---|---|
| `scripts/gate-pr-close.ts` | `PreToolUse` on `Bash`, `if: "Bash(gh pr close *)"` | Denies a `gh pr close` with no non-empty `--comment` (`-c`). The reason gives the convention: the commits that integrated the pull request and what landed, or the reason it was abandoned. |

The hook matches the whole command with two regexes, with no git or network call. A `gh pr close` written as text, in a commit message or a heredoc, is denied too, which costs Claude one retry; in a chain of closes, one comment lets them all through. A variable such as `-c "$NOTE"` counts as a comment, since the hook cannot expand it. Any failure lets the call through.

## Requirements

- GitHub CLI (`gh`) authenticated
- The `gh stack` extension (`gh extension install github/gh-stack`), for `stacked-prs` only
- The `git` plugin, for `commit-push-pr` only

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
