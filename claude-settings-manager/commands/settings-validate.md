---
description: Validate __settings.jsonc against Claude Code schema
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager":*)
model: claude-sonnet-4-5
---

# Settings Validate Command

Validate `.claude/__settings.jsonc` against the official Claude Code settings schema.

**Usage:**
```bash
/settings-validate
```

**What it checks:**
1. JSONC syntax validity (proper JSON with comments stripped)
2. Schema compliance against schemastore.org/claude-code-settings.json
3. Common configuration mistakes:
   - `permissions.allow` and `permissions.deny` must be arrays
   - Hook event names must be valid (PreToolUse, PostToolUse, etc.)

## Instructions for Claude

Execute the validation command:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" validate
```

**Success output:**
```
Validating .claude/__settings.jsonc...
JSONC syntax: valid
Schema validation: passed (basic checks)
```

**Error cases:**
- JSONC syntax error: Show the error message and line number if possible
- Schema validation error: List each error and suggest how to fix it

If the schema fetch fails (network issues), validation continues with cached schema or is skipped with a warning.
