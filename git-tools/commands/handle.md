---
description: Investigate a GitHub issue, fact-check it, and optionally execute
allowed-tools:
  - Bash(gh:*)
  - Bash(git:*)
  - Read(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - Task(*:*)
  - EnterPlanMode(*:*)
  - AskUserQuestion(*:*)
---

# Issue Handler

**Usage:** `/handle <issue-number>`

Investigate a GitHub issue, verify it's still valid, and offer to execute it.

## Critical Rule

Do not speculate about code you haven't read. If the issue mentions a file, function, or pattern—read it before making any claims.

## Step 1: Fetch

```bash
gh issue view $1 --json number,title,body,state,author,createdAt,labels,comments
```

If the issue doesn't exist or is closed, report that and stop.

## Step 2: Extract Claims

From the issue body, identify:

- **The problem**: What bug, missing feature, or behavior is described?
- **Code references**: Any file paths, function names, error messages, or snippets mentioned
- **Expected vs actual**: What should happen vs what happens?
- **Reproduction**: Steps to trigger the issue, if provided

## Step 3: Investigate

For each code reference extracted above:

1. **Locate it**: `Glob` for file paths, `Grep` for function/error names
2. **Read it**: Open the file, read the relevant section
3. **Understand context**: Read surrounding code to grasp current behavior

If the issue mentions no specific files, search for keywords from the problem description.

## Step 4: Fact-Check

Issues become stale. Code changes. PRs merge without linking. Verify before investing effort.

**Check 1: Does the problem exist?**
- For bugs: Can you confirm the faulty behavior in current code?
- For features: Is the capability truly missing?

**Check 2: Already fixed?**
```bash
git log --oneline -20 -- <relevant-file>
```
Look for commits that address this. Check if related PRs were merged.

**Check 3: Outdated?**
- Has the relevant code been refactored or removed?
- Does the described behavior no longer apply?

## Step 5: Report

**If INVALID or OUTDATED:**

```
## Issue #N: [Title]

**Status: INVALID** (or OUTDATED)

**Why:** [One sentence explanation]

**Evidence:**
- [Quote from code, commit hash, or specific finding]

**Recommendation:** Close with reason: [completed | not_planned]
```

Offer to close it with an appropriate comment.

**If VALID:**

```
## Issue #N: [Title]

**Status: VALID**

**Problem:** [One sentence summary]

**Confirmed in:**
- `path/to/file.ts:123` — [what you found]

**Root cause:** [Brief explanation of why this happens]
```

## Step 6: Offer Execution

If valid, ask:

> Issue confirmed. Enter plan mode to implement a fix?

If yes, use `EnterPlanMode`. If no, done.
