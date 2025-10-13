---
description: GitHub issue CRUD - list issues with filters
argument-hint: [--state=open|closed] [--label=LABEL] [--priority=high|medium|low]
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/issue/issue:*)"]
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

**Your task:**

Execute the script to perform the list operation:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/issue/issue" list $ARGUMENTS
```

The script is already permitted via allowed-tools. Run it and report the results.