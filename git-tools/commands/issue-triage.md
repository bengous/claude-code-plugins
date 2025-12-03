---
description: Analyze an open issue and propose to treat or close it
allowed-tools:
  - Bash(gh:*)
  - Bash(git:*)
  - Read(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - AskUserQuestion(*:*)
model: claude-opus-4-5
---

# Issue Triage Command

Analyze an open issue and make a recommendation to either treat (continue working on it) or close it with an explanatory comment.

**Usage:**

```bash
/issue-triage
```

## Instructions for Claude

**Your task:** List open issues, let the user pick one, then analyze it and help decide whether to treat or close it.

### Step 1: List Open Issues

Run this command to list all open issues:

```bash
gh issue list --state open --limit 30 --json number,title,author,createdAt,labels,assignees
```

Present the issues in a table format:

```
| # | Title | Labels | Age |
|---|-------|--------|-----|
| 123 | Issue title here | `label1` `label2` | X days |
```

Then use `AskUserQuestion` to ask the user which issue they want to triage. Store the selected issue number for subsequent steps.

### Step 2: Gather Issue Information

Once the user selects an issue, run these commands to gather context:

```bash
# Get issue details (replace ISSUE_NUMBER with selected issue)
gh issue view ISSUE_NUMBER --json title,body,state,author,createdAt,updatedAt,labels,assignees,comments,milestone,projectItems

# Get issue timeline/activity
gh issue view ISSUE_NUMBER --comments
```

### Step 3: Fact-Check the Issue

Before recommending action, verify the issue is still valid:

1. **Check if the issue still exists in the codebase**
   - Search for files, functions, or patterns mentioned in the issue
   - Verify the bug/feature request is still relevant

2. **Check if already fixed/implemented**
   - Search recent commits for related changes
   - Check if linked PRs were merged

3. **Check for duplicates**
   - Search open issues for similar titles/keywords
   - Note any that should be linked or closed as duplicates

### Step 4: Analyze the Issue

Evaluate based on:

1. **Age & Activity**
   - How old is the issue?
   - When was the last activity?
   - Is there ongoing discussion or is it stale?

2. **Clarity & Quality**
   - Is the issue clearly described?
   - Are there reproduction steps (for bugs)?
   - Is there enough context to act on it?

3. **Labels & Assignment**
   - Is it properly labeled?
   - Is anyone assigned?
   - Is it in a milestone or project?

4. **Relevance**
   - Does the issue still align with project goals?
   - Is the feature/fix still needed?
   - Has the relevant code area changed significantly?

### Step 5: Present Summary

Provide a concise summary with:

```
## Issue Summary: [Title]

**Author:** @username | **Created:** X days/weeks ago | **Last activity:** Y days ago

**Labels:** [label1, label2] or none
**Assignees:** [@user] or unassigned
**Milestone:** [milestone] or none

**Fact-check results:**
- [Finding 1: e.g., "Bug confirmed - error still occurs in current code"]
- [Finding 2: e.g., "Related PR #123 was merged but didn't fully fix this"]
- [Finding 3: e.g., "Duplicate of #456"]

**Key observations:**
- [Observation 1]
- [Observation 2]
- [Observation 3]

**Recommendation:** [TREAT/CLOSE]
**Reason:** [Brief explanation]
```

### Step 6: Ask User for Decision

Use AskUserQuestion to present the options:

- **Treat**: Keep open, add labels, assign someone, or add to milestone
- **Close**: Close with an appropriate reason

### Step 7: Execute Decision

**If TREAT:**
- Ask what actions to take (label, assign, milestone, comment)
- Execute using `gh issue edit` or `gh issue comment`

**If CLOSE:**
- Draft a polite comment explaining the closure reason
- Show the draft and confirm before posting
- Execute:
  ```bash
  gh issue comment ISSUE_NUMBER --body "<comment>"
  gh issue close ISSUE_NUMBER --reason <completed|not_planned>
  ```

### Closure Reasons

Use `--reason completed` when:
- Issue was fixed (even if not by a PR linked to the issue)
- Feature was implemented
- Question was answered

Use `--reason not_planned` when:
- Won't fix (by design, out of scope)
- Duplicate (link to original)
- Cannot reproduce
- Stale with no response
- Invalid or spam

### Comment Templates

**Already Fixed:**
```
This issue has been resolved. [Brief explanation of how/when it was fixed.]

Closing as completed. If you're still experiencing this issue, please open a new issue with updated reproduction steps.
```

**Duplicate:**
```
This appears to be a duplicate of #[number].

Closing in favor of the original issue. Please follow #[number] for updates.
```

**Cannot Reproduce:**
```
We weren't able to reproduce this issue with the information provided. If you're still experiencing this:

1. Please confirm you're using the latest version
2. Provide detailed reproduction steps
3. Include any error messages or logs

Feel free to reopen with additional details.
```

**Stale:**
```
This issue has been open for a while without recent activity. We're closing it to keep the issue tracker manageable.

If this is still relevant, please reopen with any additional context or updates. We appreciate your contribution!
```

**Won't Fix:**
```
Thank you for the suggestion! After consideration, we've decided not to implement this because [reason].

We appreciate you taking the time to share your ideas. If you have other suggestions, we'd love to hear them.
```

**Needs More Info (keep open but comment):**
```
Thanks for reporting this! To help us investigate, could you provide:

- [ ] Steps to reproduce the issue
- [ ] Expected vs actual behavior
- [ ] Environment details (OS, version, etc.)
- [ ] Any error messages or logs

We'll revisit this once we have more details.
```

Customize comments based on the specific situation.
