---
name: issue
description: Write or rewrite a GitHub issue as a context-rich prompt for another agent. Proves the problem with evidence from the code, gives hints instead of a plan, ends with observable acceptance criteria. Use when the user asks to file, write, draft, open, or rewrite an issue.
argument-hint: "[issue-number] <what is wrong or wanted>"
allowed-tools: Bash(gh repo view:*), Bash(gh issue view:*), Bash(gh issue list:*), Bash(gh issue create:*), Bash(gh issue edit:*), Bash(gh label list:*), Bash(git log:*), Read, Grep, Glob
---

# Issue

An issue is a prompt with context. Its reader is a different agent, in a fresh session, with no access to this conversation. The issue proves that the problem exists and where; it does not prescribe the solution. The reader plans.

## Input

`$ARGUMENTS`

- Starts with a number: rewrite that issue. Fetch it with `gh issue view <n> --json title,body,labels,url`, keep the facts that still hold, drop the rest.
- Anything else: the request for a new issue.
- Empty: ask one question, "What is wrong, or what do you want?", then continue.

Ask nothing else unless the request cannot be located in the code at all.

## Protocol

1. **Project constraints.** Read the repo's `AGENTS.md` or `CLAUDE.md` for two things only: the validation commands, and the boundaries the reader must respect. They go in *Done when* and *Hints*.
2. **Evidence.** Locate the code the request touches. Read it before citing it. Each fact gets an anchor the reader can jump to: `path:line` plus the symbol name, or a commit hash. Run `git log --oneline -10 -- <file>` when history explains the current state. Search once for a duplicate: `gh issue list --search "<keywords>" --state all --limit 10`; link a match in *Evidence* and say so to the user.
3. **Body.** Fill the template below. Size follows the problem: a small bug fits in fifteen lines.
4. **Confirm.** Show the title and the full body. Ask one question: create (or update), or change something. Suggest labels only from `gh label list`.
5. **Publish.** Write the body to a temporary file outside the repo, then:

   ```bash
   gh issue create --title "<title>" --body-file <tmp> --label "<a>,<b>"
   gh issue edit <n> --body-file <tmp>
   ```

   `--body-file` keeps the markdown intact; inline `--body` breaks on backticks. Report the URL.

## Template

```markdown
## Problem

## Evidence

## Hints

## Done when

## Out of scope
```

**Problem.** What is observed and what is wanted, one to three sentences. No cause, no solution.

**Evidence.** One bullet per fact, each with its anchor. Quote the exact line when it is short. Include the reproduction command when one exists. Link related issues, PRs, and commits here; there is no separate "Related" section.

**Hints.** What the writer learned that saves the reader time: where to start, what to look for, traps, adjacent code that must keep working, project boundaries. Suggestions carry "consider" or "probably"; facts do not. Never a numbered plan.

**Done when.** Checkboxes, each observable: a behavior, a test, a command from step 1 that passes.

**Out of scope.** What the reader must not touch or fix on the way. Omit the section when there is nothing to say.

## Style

- Facts read as facts. Uncertainty is stated, never hidden behind "should" or "maybe".
- One issue, one problem. Two workstreams means two issues.
- The reader has the code and the tools. Do not paste what a `Read` on the anchor shows.
