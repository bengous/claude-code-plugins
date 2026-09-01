---
name: triage
description: "Verify an open GitHub issue or PR against the current code and decide its fate: implement, keep, or close with a factual comment. Use when the user asks to triage, verify, check, handle, or clean up an issue, a PR, or the tracker."
argument-hint: "[number|url]"
allowed-tools: Bash(gh issue:*), Bash(gh pr:*), Bash(git log:*), Bash(git show:*), Bash(git diff:*), Read, Grep, Glob
---

# Triage

Decide the fate of one issue or PR from the current code. Never state something about code you did not read this session.

## Target

`$ARGUMENTS`

- A URL with `/pull/` is a PR, with `/issues/` an issue.
- A bare number: `gh issue view <n> --json url`; a `/pull/` URL means it is a PR.
- Empty: run `gh issue list --limit 30` and `gh pr list --limit 30`, show both lists, ask which one to triage.

## Protocol

1. **Fetch.**
   - Issue: `gh issue view <n> --json title,body,state,labels,comments,url`
   - PR: `gh pr view <n> --json title,body,state,baseRefName,headRefName,mergeable,reviewDecision,statusCheckRollup,comments,url,additions,deletions` and `gh pr diff <n> --stat`

   Closed already: report it and stop.

2. **Extract the claims.** The problem, every file, symbol, or error named, expected versus actual, the reproduction if given, the open questions in the comments.

3. **Verify each claim.** Glob and Grep to locate, Read to confirm. `git log --oneline -20 -- <file>` finds a fix that landed without a link. For a PR, also check: does it apply to the current base (`mergeable`), do the checks pass, does the code it changes still exist on the base, has a competing change landed since.

4. **Verdict.** One word, with the proof next to it.

   | Issue | PR |
   |---|---|
   | `valid`: confirmed in the code, root cause named | `mergeable`: applies, checks pass, still wanted |
   | `fixed`: name the commit | `needs-rebase`: conflicts or stale base |
   | `outdated`: the code it describes is gone or changed | `superseded`: name the commit or PR that landed instead |
   | `duplicate`: of #N | `stale`: an open question with no answer, give the date |
   | `unclear`: what is missing to verify | `unclear`: what is missing to verify |

5. **Report** in this shape, then ask.

   ```
   ## #<n> <title>
   Verdict: <word>
   Proof: <anchor or commit>, <anchor or commit>
   Recommendation: <implement | keep | close as <reason>>
   ```

   AskUserQuestion with the options that fit the verdict, and put the exact comment text inside the option that would post it:

   - Implement: `EnterPlanMode` (valid issues, mergeable PRs that need work).
   - Keep, comment: post the missing-information question or the finding, leave open.
   - Close with comment.
   - Nothing.

6. **Execute** the chosen option only.

   ```bash
   gh issue close <n> --reason <completed|"not planned"|duplicate> --comment "<text>"
   gh pr close <n> --comment "<text>"
   gh issue comment <n> --body "<text>"
   ```

   Reasons: `completed` for `fixed`; `duplicate` for `duplicate`; `"not planned"` for the rest.

## Comments

A comment is one to three sentences of fact: what was verified, the commit, issue, or PR that settles it, what would reopen it. For a superseded PR, name the integrating commit and what of the PR it carries. No thanks, no boilerplate, no invitation to contribute.
