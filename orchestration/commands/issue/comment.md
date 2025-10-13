---
description: Add comment to a GitHub issue
argument-hint: <issue-number> <comment-text>
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/issue/issue":comment)
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

**Your task:**

Execute the script to perform the comment operation:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/issue/issue" comment $ARGUMENTS
```

The script is already permitted via allowed-tools. Run it and report the results.