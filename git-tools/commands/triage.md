---
description: Analyze an open PR and propose to treat or close it
argument-hint: <pr-number|pr-url>
allowed-tools:
  - Bash(gh:*)
  - Bash(git:*)
  - Read(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - AskUserQuestion(*:*)
model: claude-opus-4-5
---

# PR Triage Command

Analyze an open pull request and make a recommendation to either treat (continue working on it) or close it with an explanatory comment.

**Usage:**

```bash
# By PR number
/triage 123

# By PR URL
/triage https://github.com/owner/repo/pull/123
```

## Instructions for Claude

**Your task:** Analyze the PR and help the user decide whether to treat or close it.

### Step 1: Gather PR Information

Run these commands to gather context:

```bash
# Get PR details (title, body, state, author, dates, labels)
gh pr view $ARGUMENTS --json title,body,state,author,createdAt,updatedAt,labels,reviewDecision,reviews,comments,additions,deletions,changedFiles,mergeable,baseRefName,headRefName

# Get PR diff summary
gh pr diff $ARGUMENTS --stat

# Get PR timeline/activity
gh pr view $ARGUMENTS --comments
```

### Step 2: Analyze the PR

Evaluate the PR based on:

1. **Age & Activity**
   - How old is the PR?
   - When was the last activity?
   - Is there ongoing discussion or is it stale?

2. **Scope & Quality**
   - How many files changed? Lines added/removed?
   - Is the scope reasonable or too large?
   - Does the description explain the changes clearly?

3. **Review Status**
   - Any reviews? Approved, changes requested, or pending?
   - Are there unresolved comments?

4. **Merge Readiness**
   - Is it mergeable (no conflicts)?
   - Are CI checks passing?
   - Is it targeting the correct base branch?

5. **Relevance**
   - Does the PR still align with project goals?
   - Is the feature/fix still needed?
   - Has the code area changed significantly since?

### Step 3: Present Summary

Provide a concise summary with:

```
## PR Summary: [Title]

**Author:** @username | **Created:** X days/weeks ago | **Last activity:** Y days ago

**Scope:** +X/-Y lines across N files

**Status:**
- Reviews: [approved/changes requested/pending/none]
- Mergeable: [yes/no/unknown]
- CI: [passing/failing/unknown]

**Key observations:**
- [Observation 1]
- [Observation 2]
- [Observation 3]

**Recommendation:** [TREAT/CLOSE]
**Reason:** [Brief explanation]
```

### Step 4: Ask User for Decision

Use AskUserQuestion to present the options:

- **Treat**: Keep the PR open, possibly assign someone or request changes
- **Close**: Close the PR with a comment explaining why

### Step 5: Execute Decision

**If TREAT:**
- Ask if they want to assign someone, add labels, or leave a comment
- Execute the requested actions using `gh pr edit` or `gh pr comment`

**If CLOSE:**
- Draft a polite, professional comment explaining:
  - Thank the author for their contribution
  - Explain why the PR is being closed (stale, no longer needed, scope issues, etc.)
  - Invite them to reopen if circumstances change
- Show the draft comment and confirm before posting
- Execute:
  ```bash
  gh pr comment $ARGUMENTS --body "<comment>"
  gh pr close $ARGUMENTS
  ```

### Comment Templates

**Stale PR:**
```
Thank you for this contribution! This PR has been open for a while without recent activity. We're closing it to keep our PR queue manageable.

If this change is still relevant, please feel free to reopen this PR or create a new one with updated changes. We appreciate your contribution!
```

**Superseded:**
```
Thank you for this contribution! This change has been superseded by other work in the codebase.

We appreciate the effort you put into this PR. If you have other ideas or contributions, we'd love to see them!
```

**Scope too large:**
```
Thank you for this contribution! This PR covers a lot of ground, which makes it difficult to review effectively.

Would you consider breaking this into smaller, focused PRs? That would help us review and merge changes more quickly. Happy to discuss how to split this up!
```

Customize the comment based on the specific situation and your analysis.
