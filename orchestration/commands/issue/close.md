---
description: Close a GitHub issue
argument-hint: <issue-number> [comment]
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/issue/issue":close)
model: claude-sonnet-4-5
---

Close a GitHub issue, optionally with a closing comment.

**Common patterns:**

```bash
# Simple close
/issue:close 141

# Close with reason
/issue:close 141 "Fixed in PR #156"

# Close as wontfix
/issue:close 145 "Wontfix - outside project scope"

# Close as duplicate
/issue:close 148 "Duplicate of #142"
```

**Arguments:**

- `<issue-number>` (required) - GitHub issue number to close
- `[comment]` (optional) - Closing comment explaining why

**Use cases:**

- Task completed successfully
- Issue resolved by other work
- Issue marked as wontfix
- Duplicate issue

**Related commands:**

- `/issue:reopen` - Reopen a closed issue
- `/issue:comment` - Add comment without closing
- `/issue:view` - View issue state

!"${CLAUDE_PLUGIN_ROOT}/scripts/issue/issue" close $ARGUMENTS
