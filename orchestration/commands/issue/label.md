---
description: Manage labels on a GitHub issue
argument-hint: <issue-number> [--add=LABEL] [--remove=LABEL]
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Add or remove labels on a GitHub issue. Supports atomic operations to modify labels without affecting others.

**Common patterns:**

```bash
# Add a label
/issue:label 141 --add=bug

# Remove a label
/issue:label 141 --remove=enhancement

# Add and remove simultaneously
/issue:label 141 --add=bug --remove=enhancement

# Add multiple labels
/issue:label 141 --add=bug --add=priority:high
```

**Arguments:**

- `<issue-number>` (required) - GitHub issue number
- `--add=LABEL` - Label to add (can be used multiple times)
- `--remove=LABEL` - Label to remove (can be used multiple times)

**Common labels:**

- `ai-task` - AI-managed task
- `priority:high|medium|low` - Priority level
- `status:available|in-progress|completed` - Task status
- `bug`, `enhancement`, `refactor` - Issue type
- `wontfix`, `duplicate` - Resolution status

**Related commands:**

- `/issue:view` - View current labels
- `/issue:list` - Filter by labels

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "/home/b3ngous/projects/claude-plugins/orchestration"`

**Your task:**

Execute the issue management script:

```bash
<plugin-location-from-above>/scripts/issue/issue label $ARGUMENTS
```

Show the full output to the user.