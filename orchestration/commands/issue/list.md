---
description: List GitHub issues with optional filters
argument-hint: [--state=open|closed|all] [--label=LABEL] [--priority=high|medium|low]
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/issue/issue":list)
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

**Your task:**

Execute the script to perform the list operation:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/issue/issue" list $ARGUMENTS
```

The script is already permitted via allowed-tools. Run it and report the results.