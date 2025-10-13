---
description: Reopen a closed GitHub issue
argument-hint: <issue-number> [comment]
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Reopen a previously closed GitHub issue, optionally with a comment explaining why.

**Common patterns:**

```bash
# Simple reopen
/issue:reopen 141

# Reopen with reason
/issue:reopen 141 "Issue not fully resolved, regression found"

# Reopen after new information
/issue:reopen 145 "New context makes this relevant again"
```

**Arguments:**

- `<issue-number>` (required) - GitHub issue number to reopen
- `[comment]` (optional) - Comment explaining why issue is being reopened

**Use cases:**

- Regression discovered after closing
- Original fix incomplete
- Issue closed prematurely
- New information makes issue relevant

**Related commands:**

- `/issue:close` - Close an issue
- `/issue:comment` - Add comment to issue
- `/issue:view` - View issue state

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "$HOME/projects/claude-plugins/orchestration"`

**Your task:**

Execute the issue management script:

```bash
<plugin-location-from-above>/scripts/issue/issue reopen $ARGUMENTS
```

Show the full output to the user.