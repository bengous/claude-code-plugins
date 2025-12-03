---
description: Sync JSONC settings to JSON
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager":*)
  - Glob(*:*)
  - Read(*:*)
model: claude-sonnet-4-5
---

# Settings Sync Command

Sync `__settings.jsonc` to `settings.json`.

## Your Task

### Step 1: Find Settings Files

Look for the JSONC source file in common locations:
- `.claude/__settings.jsonc` (project)
- `dot_claude/__settings.jsonc` (chezmoi dotfiles)
- `~/.claude/__settings.jsonc` (global)

Use Glob to find it:
```bash
# Check project first
ls .claude/__settings.jsonc 2>/dev/null

# Check for chezmoi
ls dot_claude/__settings.jsonc 2>/dev/null
```

### Step 2: Determine Target

The target is typically the same path with `settings.json` instead of `__settings.jsonc`:
- `.claude/__settings.jsonc` -> `.claude/settings.json`
- `dot_claude/__settings.jsonc` -> `dot_claude/settings.json`
- `~/.claude/__settings.jsonc` -> `~/.claude/settings.json`

### Step 3: Execute Sync

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" sync \
  --source <source_path> \
  --target <target_path>
```

### Step 4: Report Result

Show the sync result to the user.

**If source not found:**
```
No __settings.jsonc found. Run /settings-setup first to configure the JSONC workflow.
```

**On success:**
```
Synced: <source> -> <target>
```

**On parse error:**
Explain the JSONC syntax error and suggest fixes (common issues: trailing commas, unquoted keys).
