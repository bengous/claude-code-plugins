---
description: Check if settings are in sync
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager":*)
  - Glob(*:*)
  - Read(*:*)
model: claude-sonnet-4-5
---

# Settings Check Command

Check if `settings.json` matches what would be generated from `__settings.jsonc`.

## Your Task

### Step 1: Find Settings Files

Look for the JSONC source file:
- `.claude/__settings.jsonc` (project)
- `dot_claude/__settings.jsonc` (chezmoi dotfiles)
- `~/.claude/__settings.jsonc` (global)

### Step 2: Execute Check

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" check \
  --source <source_path> \
  --target <target_path>
```

### Step 3: Report Result

**Exit code 0 - In sync:**
```
Settings are in sync.
```

**Exit code 1 - Out of sync:**
```
Settings are out of sync!

[Show the diff output from the command]

To fix: Run /settings-sync
```

**Exit code 2 - Missing files:**
```
Missing files:
- <path> not found

Run /settings-setup to configure the JSONC workflow.
```

## Use Case

This command is useful for:
- CI pipelines to verify settings weren't directly edited
- Pre-commit verification
- Debugging sync issues
