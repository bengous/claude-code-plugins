---
description: Install t-plan hooks for automated state management
argument-hint: "[--remove|--dry-run|--force]"
allowed-tools:
  - Bash(*:*)
---

Install t-plan hooks for automated state management and contract verification.

**Your task:** Execute `bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-hooks.ts" $ARGUMENTS`

This installs two hooks:
- **PreToolUse:Task** - Automates state.json updates when dispatching t-plan subagents
- **SubagentStop:\*** - Verifies subagents fulfilled their contract output

Options:
- `--dry-run` - Preview changes without writing
- `--force` - Reinstall even if already present
- `--remove` - Remove plugin hooks
