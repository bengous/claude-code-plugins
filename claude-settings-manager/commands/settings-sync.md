---
description: Manually sync __settings.jsonc to settings.json
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager":*)
model: claude-sonnet-4-5
---

# Settings Sync Command

Manually sync `.claude/__settings.jsonc` to `.claude/settings.json`.

**Usage:**
```bash
/settings-sync
```

**When to use:**
- After editing `__settings.jsonc` and wanting to see changes immediately
- If auto-sync on commit isn't working
- To verify sync works before committing

## Instructions for Claude

Execute the sync command:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" sync
```

**Success output:**
```
Syncing settings...
Synced: .claude/__settings.jsonc -> .claude/settings.json
```

**Error cases:**
- If `__settings.jsonc` doesn't exist, suggest running `/settings-setup`
- If JSONC has syntax errors, report the parse error and suggest fixes

Report the result to the user.
