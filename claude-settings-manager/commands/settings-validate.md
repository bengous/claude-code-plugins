---
description: Validate JSONC settings against schema
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager":*)
  - Glob(*:*)
  - Read(*:*)
model: claude-sonnet-4-5
---

# Settings Validate Command

Validate `__settings.jsonc` against the Claude Code settings schema.

## Your Task

### Step 1: Find Settings File

Look for the JSONC source file:
- `.claude/__settings.jsonc` (project)
- `dot_claude/__settings.jsonc` (chezmoi dotfiles)
- `~/.claude/__settings.jsonc` (global)

### Step 2: Execute Validation

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" validate \
  --source <source_path>
```

### Step 3: Report Result

**JSONC syntax valid + schema valid:**
```
Validation passed!

- JSONC syntax: valid
- Schema check: passed
```

**JSONC syntax error:**
```
JSONC syntax error: <error message>

Common issues:
- Trailing comma after last property
- Missing quotes around keys
- Unterminated string or comment
```

**Schema validation errors:**
```
Schema validation errors:
- <list of errors>

See the Claude Code settings documentation for valid configuration options.
```

## What It Checks

1. **JSONC Syntax**: Verifies the file is valid JSONC (JSON with comments)
2. **Schema Compliance**: Validates against `json.schemastore.org/claude-code-settings.json`
   - `permissions.allow` and `permissions.deny` are arrays
   - Hook event names are valid (PreToolUse, PostToolUse, etc.)
