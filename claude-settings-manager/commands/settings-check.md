---
description: Check if settings.json is in sync with __settings.jsonc
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager":*)
model: claude-sonnet-4-5
---

# Settings Check Command

Check if `.claude/settings.json` matches what would be generated from `.claude/__settings.jsonc`.

**Usage:**
```bash
/settings-check
```

**Exit codes:**
- `0` - Files are in sync
- `1` - Files are out of sync (shows diff)
- `2` - Missing files (source or target)

**Use cases:**
- CI pipelines to ensure settings weren't directly edited
- Pre-commit verification
- Debugging sync issues

## Instructions for Claude

Execute the check command:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" check
```

**In sync output:**
```
In sync
```

**Out of sync output:**
```
Out of sync

Diff (expected vs actual):
< expected line
---
> actual line
```

**Missing files:**
```
Warning: .claude/__settings.jsonc not found
```

If files are out of sync, suggest running `/settings-sync` to fix.

If __settings.jsonc is missing, suggest running `/settings-setup` first.
