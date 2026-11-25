# GitHub Flow Plugin

GitHub lifecycle for Claude Code through `gh`: agent-ready issues, review-ready PRs, stacked PRs, issue and PR triage, CI-gated merge.

## Skills

| Skill | Invocation | What it does |
|-------|------------|--------------|
| `issue` | `/github-flow:issue [--dry-run] [number] <request>` | Writes or rewrites an issue as the goal and how to tell it is reached: a problem in two lines, a *Done when* visual of testable situations, *Not this*, and only when the session already holds context, the author's leads folded. `skills/issue/scripts/check-issue.ts` refuses any other shape before it is published. |
| `pr` | `/github-flow:pr [--dry-run] [image.png#alt ...] [notes]` | Settles the branch's open decisions, reviews it, pushes it and opens or updates its PR with a body that shows the change first: a diagram, a tree diff, a table or screenshots; images go up through `gh --attach`. |
| `triage` | `/github-flow:triage [--dry-run] [number\|url]` | Verifies an issue or PR against the current code, gives a one-word verdict with proof, then closes or comments as the verdict fixes; valid work is reported, not implemented. Manual. |
| `await-merge` | `/github-flow:await-merge [--dry-run] [--rebase] [pr]` | Watches the checks, merges by squash (`--rebase` for atomic commits, never a merge commit), fast-forwards the local base branch. |
| `commit-push-pr` | `/github-flow:commit-push-pr [issue] [images] [notes]` | Chains `git:commit` then `github-flow:pr`. |
| `stacked-prs` | `/github-flow:stacked-prs [subcommand \| symptom]` | Runs a stack of PRs with `gh stack`: the cycle, the rules the CLI does not enforce, the repair table, and a worktree per layer cut from the top of the stack with its handoff symlinked in. |

`issue`, `pr` and `stacked-prs` invoke themselves when the request matches. `triage`, `await-merge` and `commit-push-pr` run only on an explicit call: each one closes, merges or pushes, and "check issue 12" must not close issue 12.

No skill asks before it publishes, closes or merges: an orchestrating agent has nobody to answer. A PR body asks nothing either: with a user in the session, `pr` puts the branch's open decisions to them before publishing; without one, it settles them and writes each in *Decisions*, so a subagent never blocks on a question. `--dry-run` does the whole job and prints what would be sent instead of sending it; rerun without it to send.

`github-flow` depends on the `git` plugin, installed with it.

### PR shape

Agents review the PR first; the body is for the human who opens it afterwards. It shows the change, then says only what a picture cannot:

```markdown
Closes #N.
<two lines: the problem, what the change does>
## Before / After   the views: a diagram, a tree diff, a shaped diff, a table, screenshots
## Decisions        each choice: what was kept, what was set aside, why, the line that undoes it
## Checks           the review and its findings; commands with their numbers;
                    added tests as Test | Mutant | Seen failing
## Left open        limits, what was read but not run, what was not measured, views left out,
                    diagrams not seen rendered
```

The branch is reviewed before the body is written, so the body describes the final head: `/code-review` against the base, and `plugin-dev:skill-reviewer` when a `SKILL.md` or an agent changes. The validation commands the body reports are the ones the repository's `AGENTS.md` or `CLAUDE.md` names.

The view follows the kind of change: a `flowchart TB` for an architecture or a data model, a `sequenceDiagram` for behaviour over time, a tree diff for moved directories, pseudocode as a diff for logic, a call tree for runtime control flow, a component tree for UI structure, screenshots for what a user sees. A standard change gets one view, a large one (≥ 10 files, ≥ 300 lines, or a shared module) three at most. `scripts/tree-diff.ts origin/<base>` prints the tree diff: a directory moved, added or deleted whole is one line. `skills/pr/references/` holds a worked example of each view and the Mermaid traps measured on GitHub; a body with a diagram is checked in a browser that can open the PR, and without one *Left open* says so. The menu of views and some of its wording come from Dex Horthy's `show-me` and Matt Pocock's `pr`, both MIT: `skills/pr/CREDITS.md`.

A visual change carries a Before/After pair: the agent captures both states with the session's browser tool when none is given, and `gh pr create --attach '<capture dir>/before.png#alt'` uploads them from a `mktemp -d` directory outside the repository; the alt text names what the reader sees. The body ends with `<!-- opened_by: <session id> -->`, joined by `<!-- updated_by: <session id> -->` on an update, so the session behind a PR is found with `claude --resume <id>` whether or not it had a plan; inside a subagent the id is the parent session's.

### Issue shape

```markdown
<title: the state once done, not the action>
<problem: 1 to 2 lines, what is observed and what it costs, no cause in the code>
**Done when** <the expected result; one line on what is contract and what is free>
<the visual: one situation per row or panel, one of them for no regression>
**Not this** <3 lines at most>
<details><summary>Author's leads</summary> only from context the session holds </details>
<sub>Written by <model></sub>
```

The reader is a different agent in a fresh session. It explores the code itself and plans, so the goal and how to tell it is reached carry the issue, and the writer does not explore the code for it. Most issues have no author's leads: the block passes on context a session already holds from earlier work (the part of the architecture, a symbol or concept to start from, a trap), which the reader treats as hypotheses to check, never a fix or a plan. The visual of *Done when* is a set of terminal sessions, a mockup of the states, a timeline, a chart with its target, or a *Today / Expected* table; each situation is a test a cloud session can run. A visual over 40 lines goes to an issue artifact of type `embedded_html`, uploaded with `gh api repos/{owner}/{repo}/issues/<n>/artifacts`, which *Done when* links.

### Issue check

The skill runs `bun skills/issue/scripts/check-issue.ts <body.md>` on its draft before it publishes, and fixes each finding until the check exits 0. The checks are the part of the shape a script can decide:

| Check | Finding |
|---|---|
| `heading`, `section` | A heading, a paragraph that opens on a bold label other than **Done when** and **Not this**, or a folded section other than the author's leads. |
| `order`, `footer` | The parts out of order, or no `<sub>Written by …</sub>` last line. |
| `problem`, `not-this` | A problem over `problemLines`, *Not this* over `notThisLines`. |
| `done-when`, `situations` | No **Done when**, or one whose visual lists no situation: no table row, no non-empty fenced block, no issue artifact named. |
| `contract`, `regression`, `expected` | No line on what is contract and what is free, no situation for no regression, a row with no expected result. |
| `checkbox` | A task list item. |
| `visual-size` | A fenced block or a table over `visualLines`: it moves to an issue artifact. |
| `fix`, `plan` | A fix handed over as the thing to do: `Fix:`, `Solution:`, `Approach:`, `Workaround:`, a suggested or proposed fix or solution; a numbered list of steps. A lead passes: the part of the architecture, a symbol or concept, domain context. |
| `question` | A `?` outside code spans, fenced blocks, URLs and HTML comments. |
| `leads` | The author's leads outside a `<details>`. |
| `script` | In an `.html` artifact: a `<script>`, an on-event attribute or a `javascript:` URL; an artifact also lists its situations as table rows, one for no regression. |

Findings print as `<file>:<line>: <check>: <message>`; exit 1 on a finding, 2 on a file it cannot read or settings it refuses. `-` reads the body from stdin; a file ending in `.html` is checked as an artifact. A repository tunes the caps in `.github/github-flow.json`, found from the current directory upward to the first directory with `.git`, under `issue`: `problemLines` (2), `notThisLines` (3), `visualLines` (40); the `pr` check reads the same file under `pr`. A missing file or key keeps the defaults; an unknown key or a value that is not a positive integer exits 2. The script imports nothing outside `skills/issue/`, so the skill and its check copy into another repository together.

### Triage verdicts

| Issue | PR |
|---|---|
| `valid`, `fixed`, `outdated`, `duplicate`, `unclear` | `mergeable`, `needs-rebase`, `superseded`, `stale`, `unclear` |

Close comments are one to three sentences of fact: what was verified and the commit, issue, or PR that settles it.

### Stacked PRs

`stacked-prs` documents `gh stack` (the `github/gh-stack` extension): one PR per layer, each based on the layer below, landed atomically bottom to top. It carries the rules the CLI leaves to the caller (branch from the top, one checkout per session, verify content after every rebase, nothing on the trunk before landing) and a repair table keyed by symptom. `scripts/worktree-handoff.ts <branch> --base origin/<top>` cuts a worktree for a parallel session: it symlinks the gitignored orchestration folder (`.gh/` by default) so the session finds its handoff and its checklist writes come back to the main checkout, adds the folder to `info/exclude`, and installs dependencies from the lockfile. The handoff template lives in `skills/stacked-prs/assets/`.

## Plans on pull requests

Three hooks carry the plan of a session to the pull request that session creates, so the plan is read where the diff is reviewed instead of in a file nobody opens.

| Hook | Event | What it does |
|---|---|---|
| `scripts/stamp-plan.ts` | `PreToolUse` on `Write` | On a Write of the harness's own plan file, `~/.claude/plans/<slug>.md`, puts the session line at the top of the content before the file is written. |
| `scripts/gate-plan.ts` | `PreToolUse` on `ExitPlanMode` | Lints the plan ([Plan lint](#plan-lint)). A plan it does not deny goes to `scripts/capture-plan.ts`, which writes it to `~/.claude/plans/by-session/<session_id>[/<agent_id>].md`, tags the harness's own plan file with the session id when it is not tagged yet, then refreshes the comment when the checkout already has a PR. |
| `scripts/attach-plan.ts` | `PostToolUse` on `Bash` | On a `gh pr create` whose output carries a `<host>/<owner>/<repo>/pull/<n>` URL, posts the session's own plan, or the plan of the session named by a marker in its transcript, on that PR of that repository. |

The key is the identity the session already has when the plan is approved: `session_id`, plus `agent_id` when the plan is approved inside a subagent. The branch is not asked for, so the worktree that does not exist yet, the `worktree-<n>` branch renamed later, and a `cd <other-checkout> && gh pr create` all change nothing; the repository comes from the PR URL, not from the session cwd, so `cd ../other-repo && gh pr create` posts on the other repository's PR. A session with no plan of its own and no planning marker in its transcript gets no comment. A subagent handed a plan in its prompt is such a session: it never approved a plan, so its PR carries one only when that plan text kept the `<!-- session_id: <id> -->` line, which the transcript scan then finds.

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
