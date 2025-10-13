---
description: Add custom metadata to worktree for tracking/automation
argument-hint: <name> --meta '{...}'
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree":annotate)
model: claude-sonnet-4-5
---

Add or update custom metadata fields on a worktree for tracking, automation, or organizational purposes. Metadata is merged with existing data and persisted in worktree management files.

**Common patterns:**

```bash
# Mark as reviewed
/worktree:annotate my-feature --meta '{"reviewed": true, "reviewer": "alice"}'

# Add tags for categorization
/worktree:annotate api-work --meta '{"tags": ["backend", "database"]}'

# Track deployment status
/worktree:annotate hotfix --meta '{"deployed": true, "environment": "production"}'

# Add custom tracking fields
/worktree:annotate experiment --meta '{"priority": "high", "deadline": "2025-10-15"}'
```

**Flags/Arguments:**

- `<name>` (required) - Worktree identifier
- `--meta <json>` (required) - JSON object with custom fields

**Behavior:**

- Validates JSON syntax before applying
- Merges new metadata with existing metadata (shallow merge)
- Overwrites existing fields with same keys
- Updates `updated_at` timestamp
- Logs annotation event

**JSON requirements:**

- Must be valid JSON object syntax
- Use single quotes around JSON, double quotes inside
- Example: `'{"key": "value", "num": 42}'`

**Use cases:**

1. **Review tracking**: Mark reviewed worktrees
2. **Categorization**: Add tags or labels
3. **Status tracking**: Record deployment, testing status
4. **Project management**: Deadlines, priorities, assignments
5. **Automation**: Custom fields for scripts

**Viewing metadata:**

Use `/worktree --json` to see all worktree metadata including custom fields.

**Related commands:**

- `/worktree` - View metadata with `--json` flag
- `/worktree:logs` - See annotation history

**Your task:**

Execute the script to perform the annotate operation:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree" annotate $ARGUMENTS
```

The script is already permitted via allowed-tools. Run it and report the results.