---
name: shift
description: "Run one pass of the issue-to-PR loop: triage the open issues, dispatch the ready ones to agents, keep the loop's pull requests green, land the ones their worker left, and return a digest. Use when the user asks to run a shift, to work the backlog on its own, or to run the issue loop."
argument-hint: "[--max <n>] [--dry-run]"
allowed-tools: Bash(gh issue:*), Bash(gh pr list:*), Bash(gh pr view:*), Bash(gh pr edit:*), Bash(gh pr comment:*), Bash(gh label:*), Bash(gh api:*), Bash(git log:*), Agent, Skill, Read, Grep, Glob
---

# Shift

One pass over the tracker with nobody watching. The state lives on GitHub, in labels, never in a file: a shift that runs twice does its work once.

## Input

`$ARGUMENTS`

- `--max <n>`: issues dispatched this pass. Default 2, for cost.
- `--dry-run`: print each action in place of taking it. No comment, no label, no worker, no landing.

## Protocol

1. **Labels.** `gh label list --limit 100`. Create the ones it does not list: `needs-info`, `dispatched`, `blocked` for issues; `shift`, `needs-human`, `tier:low`, `tier:human`, `land-ok` for PRs.

   ```bash
   gh label create needs-info --description "Missing evidence or acceptance criteria"
   gh label create tier:low --description "Lands on green checks without a human"
   gh label create tier:human --description "Waits for the human's land #N"
   gh label create land-ok --description "The human typed land #N in a session"
   ```

2. **Triage.** `gh issue list --state open --json number,title,labels,createdAt`. Drop the ones already labelled `dispatched`, `blocked`, `needs-info` or `epic`. Oldest first, `bug` before the rest. Read `${CLAUDE_PLUGIN_ROOT}/skills/triage/SKILL.md` and apply its protocol to each: it verifies the issue against the current code and closes or comments as its verdict fixes. Read it, do not invoke it: `github-flow:triage` is a manual skill. `unclear` → label `needs-info`. `valid` → candidate.
3. **Dispatch.** The first `--max` candidates, in one call to `github-flow:dispatch` with their numbers.
4. **Maintain.** `gh pr list --state open --label shift --json number,url,headRefName,headRefOid,mergeable,statusCheckRollup,reviewDecision,comments,labels`. Skip the ones labelled `needs-human`: two fix rounds were not enough.
   - **Fix.** A PR with a red check, `mergeable: CONFLICTING`, or an unanswered comment goes to one worker in `fix <pr>` mode: `${CLAUDE_PLUGIN_ROOT}/skills/dispatch/references/worker-brief.md` filled as `github-flow:dispatch` fills it, in a `general-purpose` subagent, `model: opus` and `isolation: worktree` on the call. A comment counts only when its `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR` and its first line is no `<!-- … -->` marker. Count the PR's comments whose first line is `<!-- shift-fix -->` first: at two, label `needs-human` and leave the PR alone.
   - **Land.** A PR no worker took this pass, labelled `tier:low` or `land-ok`, its checks green, `mergeable: MERGEABLE`, no comment unanswered. Its own worker is done: `dispatch` adds `shift` only once the worker reported, and a `fix` worker never lands. Run the `land` command of `.claude/github-flow.json` on its branch with Bash `run_in_background`, and read its last line in the task notification. With no `land` command, every PR waits for the human, who lands it with `/github-flow:await-merge`.
5. **Record a blocked fix.** A `fix` worker posts its own `<!-- shift-fix -->` comment. One that reports `blocked` does not: post it, written to a file outside the repository, with `gh pr comment <pr> --body-file <tmp>`, first line `<!-- shift-fix -->`, then the first line of the failure. Step 4 counts these comments; without them the 2-attempt bound never fires.
6. **Digest.** The report is the deliverable.

   ```
   Triaged      #<n> <verdict>, ...
   Dispatched   #<n> -> <pr url> <tier>
   Landed       <pr url> <tier>: <reason>
   Not landed   <pr url> <tier>: <the land command's last line>
   Fixed        <pr url> <what changed>
   Blocked      #<n> <first line of the failure>
   Needs you    <pr url> human: <reason> — <first entry of its Decisions>
   Low escapes  30 d: <M>/<N> — <the M pr urls>
   ```

   *Not landed* lists each PR whose `land` command this pass ended without landing it, a `tier:low` PR held while `dev` is red included. *Needs you* lists each open `shift` PR that is neither `tier:low` nor labelled `land-ok`, a PR with no tier label written `human: no tier label`: the human reads it and types `land #<n>` in a session. A PR whose newest `<!-- land-ok: void … -->` comment is newer than its last `land-ok` is written `human: re-read <what that comment links>, <n> commits since your ok` in place of its reason: the human reads those commits alone. *Low escapes*: N counts the `tier:low` PRs merged in the last 30 days (`gh pr list --state merged --label tier:low --search "merged:>=<date 30 days ago>" --json url,mergedAt,files`); M counts those with a file that a commit on `origin/<base>` whose subject starts with `fix` or `revert` touched within 7 days of the merge (`git log origin/<base> --since=<mergedAt> --until=<mergedAt plus 7 days> --format=%s --name-only`). The human opens only the M. An empty section is written empty, not dropped.

Never merges through GitHub, never closes a PR, never pushes `main`; it lands only through the repository's landing command, which gates each landing on its tier, CI and `land-ok`.
