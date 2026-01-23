---
description: Install t-plan hooks for session init, state management, and contract verification
argument-hint: "[--remove|--dry-run|--force]"
allowed-tools:
  - Bash(*:*)
---

Install t-plan hooks into `~/.claude/settings.local.json`.

**Your task:** Execute `bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-hooks.ts" $ARGUMENTS`

This installs 3 hooks:
- **PreToolUse:Skill** - Session init (filtered to t-plan skill only)
- **PreToolUse:Task** - State management for subagent dispatches
- **SubagentStop:\*** - Verifies subagents fulfilled their contract output

Options:
- `--dry-run` - Preview changes without writing
- `--force` - Reinstall even if already present
- `--remove` - Remove plugin hooks

Note: This is a workaround for GitHub #17688 (skill-scoped hooks don't work in plugins).
