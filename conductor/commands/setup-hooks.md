---
description: Install t-plan SubagentStop hook for contract verification
argument-hint: "[--remove|--dry-run|--force]"
allowed-tools:
  - Bash(*:*)
---

Install SubagentStop hook for t-plan contract verification.

**Your task:** Execute `bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-hooks.ts" $ARGUMENTS`

This installs one hook:
- **SubagentStop:\*** - Verifies subagents fulfilled their contract output

Note: PreToolUse hooks (init + coordinator) are now skill-scoped
and automatically active when using /t-plan.

Options:
- `--dry-run` - Preview changes without writing
- `--force` - Reinstall even if already present
- `--remove` - Remove plugin hooks
