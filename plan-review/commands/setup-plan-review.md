---
description: Install plan review hooks into project settings
argument-hint: "[--remove|--dry-run|--force]"
allowed-tools:
  - Bash(*:*)
model: haiku
---

Install plan review hooks into `.claude/settings.local.json`.

**What it installs:**

1. **plan-review-gate** (PreToolUse:ExitPlanMode) - Requires multi-agent review before plan execution

**Usage:**

```bash
# Install hooks
/plan-review:setup-plan-review

# Preview changes without writing
/plan-review:setup-plan-review --dry-run

# Reinstall (overwrites existing plugin hooks)
/plan-review:setup-plan-review --force

# Remove hooks
/plan-review:setup-plan-review --remove
```

**Your task:**

Execute the setup script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-plan-review.js" $ARGUMENTS
```

Run the setup script with the provided arguments.
