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

Determine the plugin location and execute the setup script:

```bash
PLUGIN_DIR="$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]:-$0}")")")"
# Fallback: search for plugin
if [[ ! -d "$PLUGIN_DIR/scripts" ]]; then
  PLUGIN_DIR="$(find ~/.claude/plugins -name 'plan-review' -type d 2>/dev/null | head -1)"
fi
node "$PLUGIN_DIR/scripts/setup-plan-review.js" $ARGUMENTS
```

Run the setup script with the provided arguments.
