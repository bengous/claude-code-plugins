# Command Development

[← Back to Main Guide](../../CLAUDE.md)

Complete guide to creating and organizing slash commands in Claude Code plugins.

## Frontmatter Structure

```markdown
---
description: Brief description for command palette
argument-hint: <required> [optional] [--flag]
allowed-tools:
  - Bash(*:*)                                    # Unrestricted bash
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/*":*)   # Restricted path
  - Read(*:*)
  - Grep(*:*)
model: claude-sonnet-4-5                         # Override default model
---

[Documentation for users - what the command does, examples]

[Instructions for Claude - how to execute the command]
```

## Path Resolution Patterns

**Pattern 1: Two-Stage Resolution** (works in both dev and marketplace)
```markdown
**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/name/plugin 2>/dev/null || echo "$HOME/dev/plugin"`

Execute: `<plugin-location>/scripts/feature/script $ARGUMENTS`
```

**Pattern 2: Direct Environment Variable** (simpler)
```markdown
!"${CLAUDE_PLUGIN_ROOT}/scripts/feature/script" $ARGUMENTS
```

## Allowed-Tools Patterns

**Unrestricted (command delegates to trusted script):**
```yaml
allowed-tools:
  - Bash(*:*)
```

**Restricted (only specific script):**
```yaml
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/safe-script":*)
  - Read(*:*)
  - Grep(*:*)
```

**No tools (pure prompt):**
```yaml
allowed-tools: []
```

## Command Hierarchy

- `commands/feature.md` → `/feature`
- `commands/feature/create.md` → `/feature:create`
- `commands/feature/delete.md` → `/feature:delete`

Organize related commands in subdirectories.

---

**Related:**
- [Script Implementation](./scripts.md) - Backend script patterns
- [Quick Start](./quickstart.md) - First plugin tutorial
