---
description: Add comment to a GitHub issue
argument-hint: <issue-number> <comment-text>
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Add a comment to an existing GitHub issue.

**Common patterns:**

```bash
# Add status update
/issue:comment 141 "Working on this now"

# Add progress note
/issue:comment 162 "Completed initial implementation, running tests"

# Add blocking information
/issue:comment 145 "Blocked by #142, waiting for merge"
```

**Arguments:**

- `<issue-number>` (required) - GitHub issue number
- `<comment-text>` (required) - Comment text to add

**Use cases:**

- Status updates during work
- Progress reports
- Blocking/dependency notes
- Context for reviewers

**Related commands:**

- `/issue:view` - View issue with existing comments
- `/issue:close` - Close issue (optionally with comment)

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration`

**Your task:**

Execute the issue management script:

```bash
<plugin-location-from-above>/scripts/issue/issue comment $ARGUMENTS
```

Show the full output to the user.