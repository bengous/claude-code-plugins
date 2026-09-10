---
name: triage
description: "Verify an open GitHub issue or PR against the current code and act on the verdict: close or comment with a factual proof, or report work that is still valid. Use when the user asks to triage, verify, check, handle, or clean up an issue, a PR, or the tracker."
argument-hint: "[--dry-run] [number|url]"
allowed-tools: Bash(gh issue:*), Bash(gh pr:*), Bash(git log:*), Bash(git show:*), Bash(git diff:*), Read, Grep, Glob
---

# Triage

Decide the fate of one issue or PR from the current code. Never state something about code you did not read this session.

## Target

`$ARGUMENTS`

- `--dry-run`: verify and report, post nothing; the comment text that step 6 would post is printed.
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

5. **Report** in this shape.

   ```
   ## #<n> <title>
   Verdict: <word>
   Proof: <anchor or commit>, <anchor or commit>
   Action: <closed as <reason> | commented | none>
   ```

6. **Execute** the action the verdict fixes. No question: a wrong close reopens in one command, and a caller that wants a look first passes `--dry-run`.

   | Verdict | Action |
   |---|---|
   | `fixed` | `gh issue close <n> --reason completed --comment "<text>"` |
   | `duplicate` | `gh issue close <n> --reason duplicate --comment "<text>"` |
   | `outdated`, `superseded`, `stale` | `gh issue close <n> --reason "not planned" --comment "<text>"` or `gh pr close <n> --comment "<text>"` |
   | `unclear` | `gh issue comment <n> --body "<text>"` with the missing information named; stays open |
   | `valid`, `mergeable`, `needs-rebase` | none; the report is the deliverable, implementing is a separate request |

## Comments

A comment states facts only: what was verified, the commit, issue, or PR that settles it, what would reopen it. For a superseded PR, name the integrating commit and what of the PR it carries. No thanks, no boilerplate, no invitation to contribute.
