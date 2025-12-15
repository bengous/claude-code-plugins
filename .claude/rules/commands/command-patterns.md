---
paths: "**/commands/**/*.md"
---

# Command Patterns

## Command Frontmatter

```markdown
---
description: Brief description shown in command palette
argument-hint: <required> [optional] [--flag]
allowed-tools:
  - Bash(*:*)                                    # Unrestricted bash
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/*":*)   # Restricted to plugin scripts
  - Read(*:*)
  - Grep(*:*)
model: opus                                       # Specify for complex tasks
---

# Command Title

[Instructions for Claude on how to execute this command]
```

**Model options:**
- `opus` or `claude-opus-4-5` - Complex reasoning, multi-step workflows
- `sonnet` or `claude-sonnet-4-5` - Moderate complexity
- Default (no model specified) may use Haiku - only for simple commands

## Path Resolution

**Pattern 1: Environment variable (preferred)**
```markdown
Execute: `"${CLAUDE_PLUGIN_ROOT}/scripts/mycommand/mycommand" $ARGUMENTS`
```

**Pattern 2: Two-stage resolution (works in dev and marketplace)**
```markdown
**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/*/my-plugin 2>/dev/null || echo "$PWD"`

Execute: `<plugin-location>/scripts/mycommand/mycommand $ARGUMENTS`
```

**Why dynamic resolution:** Hardcoded paths like `/home/user/...` break when others install your plugin. Always use `${CLAUDE_PLUGIN_ROOT}` or dynamic discovery.

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

```
commands/feature.md         → /feature
commands/feature/create.md  → /feature:create
commands/feature/delete.md  → /feature:delete
```

Organize related commands in subdirectories.
