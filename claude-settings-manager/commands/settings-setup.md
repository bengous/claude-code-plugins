---
description: Scaffold JSONC settings workflow in project
argument-hint: "[--force|--dry-run|--hook-system <lefthook|husky>]"
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager":*)
  - Read(*:*)
  - AskUserQuestion(*:*)
model: claude-sonnet-4-5
---

# Settings Setup Command

Set up JSONC-based Claude Code settings management with git hooks.

**What this does:**
1. Creates `.claude/__settings.jsonc` - Your editable settings file (with comments)
2. Creates `scripts/claude/settings-sync.sh` - Portable sync script
3. Creates `scripts/git/block-settings-json.sh` - Blocks direct edits to settings.json
4. Configures git hooks (lefthook or husky) for automatic sync on commit
5. Updates `.gitattributes` to mark settings.json as generated
6. Adds `claude:sync` script to package.json (if exists)

**Usage:**
```bash
/settings-setup              # Interactive setup
/settings-setup --dry-run    # Preview changes without applying
/settings-setup --force      # Overwrite existing files
/settings-setup --hook-system lefthook  # Force specific hook system
```

## Instructions for Claude

### Step 1: Detect Current State

Run the detection command:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" detect
```

This outputs JSON showing:
- Whether settings.json and __settings.jsonc exist
- Which hook system is installed (lefthook/husky)
- Whether package.json exists
- Recommended hook system

### Step 2: Present Plan to User

Based on detection results, explain what will be created or modified.

**If __settings.jsonc already exists and --force not specified:**
Report that setup is already complete and exit.

**Otherwise, present the plan:**

Files to create:
- `.claude/__settings.jsonc` - Source of truth (supports comments)
- `scripts/claude/settings-sync.sh` - Portable sync script
- `scripts/git/block-settings-json.sh` - Blocks direct settings.json edits

Files to modify:
- `lefthook.yml` or `.husky/pre-commit` - Add pre-commit hooks
- `.gitattributes` - Mark settings.json as linguist-generated
- `package.json` - Add claude:sync script (if package.json exists)

### Step 3: Confirm with User

Use AskUserQuestion:
- Question: "Proceed with JSONC settings setup?"
- Options: "Yes, set it up" / "Preview first (--dry-run)" / "Cancel"

### Step 4: Execute Setup

Based on user's choice, run:

```bash
# For actual setup:
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" setup $ARGUMENTS

# For preview:
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" setup --dry-run $ARGUMENTS
```

### Step 5: Report Results

Show what was created/modified and provide guidance:

```
Setup complete!

Created:
  .claude/__settings.jsonc
  scripts/claude/settings-sync.sh
  scripts/git/block-settings-json.sh

Modified:
  lefthook.yml (added sync-settings, block-settings-json hooks)
  .gitattributes (added linguist-generated rule)
  package.json (added claude:sync script)

How it works:
  - Edit .claude/__settings.jsonc (supports // and /* */ comments)
  - On commit, changes auto-sync to settings.json
  - Direct edits to settings.json are blocked

Commands:
  /settings-sync      Manual sync
  /settings-check     Check if in sync (for CI)
  /settings-validate  Validate against schema
```
