---
description: List GitHub issues with optional filters
argument-hint: [--state=open|closed|all] [--label=LABEL] [--priority=high|medium|low]
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

List GitHub issues with optional filters for state, labels, and priority.

**Common patterns:**

```bash
# List all open issues
/issue:list

# Filter by label
/issue:list --label=bug

# Filter by priority
/issue:list --priority=high

# Combine filters
/issue:list --state=open --label=enhancement --priority=medium

# Show closed issues
/issue:list --state=closed
```

**Filters:**

- `--state` - Filter by state: open|closed|all (default: open)
- `--label` - Filter by specific label
- `--priority` - Filter by priority: high|medium|low

**Output format:**

Displays formatted table with:
- Issue number
- Title
- Labels
- State

**Related commands:**

- `/issue:create` - Create new issue
- `/issue:view` - View detailed issue information
- `/issue:fetch` - Get actionable issues

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "/home/b3ngous/projects/claude-plugins/orchestration"`

**Your task:**

Execute the issue management script:

```bash
<plugin-location-from-above>/scripts/issue/issue list $ARGUMENTS
```

Show the full output to the user.