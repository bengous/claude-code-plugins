---
description: Create new GitHub issue with labels and metadata
argument-hint: issue-title="..." [description="..."] [labels="..."] [priority=high|medium|low]
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Create a new GitHub issue with specified title, description, labels, and priority.

**Common patterns:**

```bash
# Simple issue
/issue:create issue-title="Fix authentication bug"

# Full context
/issue:create issue-title="Add dark mode support" \
  description="Implement dark mode with system preference detection" \
  labels="enhancement,frontend" \
  priority=high

# With priority only
/issue:create issue-title="Refactor auth module" priority=medium
```

**Arguments:**

- `issue-title` (required) - Title for the GitHub issue
- `description` (optional) - Detailed description of the issue
- `labels` (optional) - Comma-separated labels (e.g., "bug,frontend")
- `priority` (optional) - Priority level: high|medium|low (default: medium)

**Labels added automatically:**

- `ai-task` - Marks issue as part of AI task system
- `priority:{level}` - Priority label
- `status:available` - Initial status

**Output:**

Returns the created issue number for use with other commands.

**Related commands:**

- `/issue:list` - List existing issues
- `/issue:view` - View issue details

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "/home/b3ngous/projects/claude-plugins/orchestration"`

**Your task:**

Execute the issue management script:

```bash
<plugin-location-from-above>/scripts/issue/issue create $ARGUMENTS
```

Show the full output to the user.