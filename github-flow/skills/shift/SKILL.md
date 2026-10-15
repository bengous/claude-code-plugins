---
name: shift
description: "Run one pass of the issue-to-PR loop: triage the open issues, dispatch the ready ones to agents, keep the loop's pull requests green, and return a digest. Use when the user asks to run a shift, to work the backlog on its own, or to run the issue loop."
argument-hint: "[--max <n>] [--dry-run]"
allowed-tools: Bash(gh issue:*), Bash(gh pr list:*), Bash(gh pr view:*), Bash(gh pr edit:*), Bash(gh pr comment:*), Bash(gh label:*), Bash(gh api:*), Agent, Skill, Read, Grep, Glob
---

# Shift

One pass over the tracker with nobody watching. The state lives on GitHub, in labels, never in a file: a shift that runs twice does its work once.

## Input

`$ARGUMENTS`

- `--max <n>`: issues dispatched this pass. Default 2, for cost.
- `--dry-run`: print each action in place of taking it. No comment, no label, no worker.

## Protocol

1. **Labels.** `gh label list --limit 100`. Create the ones it does not list: `needs-info`, `dispatched`, `blocked` for issues, `shift`, `needs-human` for PRs.

   ```bash
   gh label create needs-info --description "Missing evidence or acceptance criteria"
   ```

2. **Triage.** `gh issue list --state open --json number,title,labels,createdAt`. Drop the ones already labelled `dispatched`, `blocked`, `needs-info` or `epic`. Oldest first, `bug` before the rest. Read `${CLAUDE_PLUGIN_ROOT}/skills/triage/SKILL.md` and apply its protocol to each: it verifies the issue against the current code and closes or comments as its verdict fixes. Read it, do not invoke it: `github-flow:triage` is a manual skill. `unclear` → label `needs-info`. `valid` → candidate.
3. **Dispatch.** The first `--max` candidates, in one call to `github-flow:dispatch` with their numbers.
4. **Maintain.** `gh pr list --state open --label shift --json number,headRefName,mergeable,statusCheckRollup,reviewDecision,comments`. Skip the ones labelled `needs-human`. A PR with a red check, `mergeable: CONFLICTING`, or a review comment nobody answered goes to one `github-flow:issue-worker` in `fix <pr>` mode, `model: opus` and `isolation: worktree` on the call. Count the PR's comments whose first line is `<!-- shift-fix -->` before dispatching: at two, label `needs-human` and leave the PR alone.
5. **Record the fix.** One comment per fix, written to a file outside the repository and posted with `gh pr comment <pr> --body-file <tmp>`. First line `<!-- shift-fix -->`, then one line naming what the worker changed, or why it reported `blocked`. These are the comments step 4 counts; without them the 2-attempt bound never fires.
6. **Digest.** The report is the deliverable.

   ```
   Triaged    #<n> <verdict>, ...
   Dispatched #<n> -> <pr url>
   Fixed      <pr url> <what changed>
   Blocked    #<n> <first line of the failure>
   Ready      <pr url> checks green, mergeable
   ```

   *Ready* is the list the human acts on. An empty section is written empty, not dropped.

Never merges, never closes a PR, never pushes `main`.
