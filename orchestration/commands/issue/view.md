---
description: View detailed information about a specific GitHub issue
argument-hint: <issue-number>
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Display detailed information about a specific GitHub issue including title, description, labels, state, and metadata.

**Common patterns:**

```bash
# View specific issue
/issue:view 141

# View recent issue
/issue:view 162
```

**Arguments:**

- `<issue-number>` (required) - GitHub issue number to view

**Output includes:**

- Issue number and title
- State (open/closed)
- Labels
- Description
- Comments
- Created/updated timestamps
- Assignees (if any)

**Related commands:**

- `/issue:list` - List all issues
- `/issue:comment` - Add comment to issue
- `/issue:label` - Manage issue labels

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "/home/b3ngous/projects/claude-plugins/orchestration"`

**Your task:**

Execute the issue management script:

```bash
<plugin-location-from-above>/scripts/issue/issue view $ARGUMENTS
```

Show the full output to the user.