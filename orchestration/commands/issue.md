---
description: GitHub issue CRUD - list issues with filters
argument-hint: [--state=open|closed] [--label=LABEL] [--priority=high|medium|low]
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

List GitHub issues with optional filters. Defaults to open issues.

**Usage:**

```bash
# List all open issues
/issue

# Filter by label
/issue --label=bug

# Filter by priority
/issue --priority=high
```

**Subcommands:**

- `/issue:create` - Create new issue
- `/issue:view` - View issue details
- `/issue:comment` - Add comment
- `/issue:label` - Manage labels
- `/issue:close` - Close issue
- `/issue:reopen` - Reopen issue
- `/issue:fetch` - Get actionable issues (internal)

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "$HOME/projects/claude-plugins/orchestration"`

**Your task:**

Execute the issue management script:

```bash
<plugin-location-from-above>/scripts/issue/issue list $ARGUMENTS
```

Show the full output to the user.