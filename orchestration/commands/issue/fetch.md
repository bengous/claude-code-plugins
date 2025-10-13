---
description: Fetch actionable issues for task execution (internal use)
argument-hint:
allowed-tools:
  - Bash("/home/b3ngous/projects/claude-plugins/orchestration/scripts/issue/issue":fetch)
model: claude-sonnet-4-5
---

Fetch actionable issues suitable for task execution. This command filters issues to return only those that are ready to be worked on.

**Filtering criteria:**

Issues are included if:
- State is open
- Not labeled with `status:in-progress`
- Not labeled with `status:completed`
- Not labeled with `wontfix` or `duplicate`

**Common patterns:**

```bash
# Get actionable issues
/issue:fetch
```

**Output format:**

Returns JSON array of actionable issues with:
- Issue number
- Title
- Labels
- Priority
- State

**Usage:**

This command is primarily used internally by the task orchestration system to populate issue pickers and determine what work is available.

**Related commands:**

- `/issue:list` - List all issues with custom filters
- `/issue:view` - View specific issue details

!"/home/b3ngous/projects/claude-plugins/orchestration/scripts/issue/issue" fetch $ARGUMENTS
