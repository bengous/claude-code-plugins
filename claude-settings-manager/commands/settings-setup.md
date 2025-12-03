---
description: Scaffold JSONC settings workflow in project
argument-hint: "[--force|--dry-run|--global|--hook-system <lefthook|husky|chezmoi>]"
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager":*)
  - Read(*:*)
  - AskUserQuestion(*:*)
model: claude-sonnet-4-5
---

# Settings Setup Command

Set up JSONC-based Claude Code settings management with git hooks or chezmoi.

## Two Modes

**Project Settings (default):**
- Source: `.claude/__settings.jsonc`
- Target: `.claude/settings.json`
- Trigger: Git pre-commit hooks (lefthook or husky)

**Global Settings (--global or chezmoi dotfiles repo):**
- Source: `dot_claude/__settings.jsonc` (chezmoi source)
- Target: `~/.claude/settings.json`
- Trigger: Chezmoi `run_onchange_` script

## Usage

```bash
# Project settings (git hooks)
/settings-setup              # Interactive setup
/settings-setup --dry-run    # Preview changes
/settings-setup --force      # Overwrite existing files
/settings-setup --hook-system lefthook  # Force lefthook

# Global settings (chezmoi dotfiles)
/settings-setup --global     # Setup for ~/.claude/settings.json
/settings-setup --hook-system chezmoi  # Force chezmoi mode
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
- Whether this is a chezmoi dotfiles repo
- Whether package.json exists
- Recommended hook system

**Detection fields:**
- `is_dotfiles_repo`: true if chezmoi patterns detected (dot_* files, .chezmoi.yaml.tmpl)
- `chezmoi_exists`: true if chezmoi config exists
- `recommended_hook_system`: "chezmoi" | "lefthook" | "husky"

### Step 2: Present Plan to User

Based on detection, explain what will be created.

**If dotfiles repo detected:**
Suggest global settings mode with chezmoi.

**For project settings (lefthook/husky):**

Files to create:
- `.claude/__settings.jsonc` - Source of truth (with comments)
- `scripts/claude/settings-sync.sh` - Portable sync script
- `scripts/git/block-settings-json.sh` - Blocks direct edits

Files to modify:
- `lefthook.yml` or `.husky/pre-commit` - Pre-commit hooks
- `.gitattributes` - Mark settings.json as generated
- `package.json` - Add claude:sync script (if exists)

**For global settings (chezmoi):**

Files to create:
- `dot_claude/__settings.jsonc` - Chezmoi source file
- `run_onchange_after_claude-settings.sh.tmpl` - Chezmoi trigger script

Files to modify:
- `.chezmoiignore` - Ignore generated settings.json

### Step 3: Confirm with User

Use AskUserQuestion:
- Question: "Proceed with setup?"
- Options based on detection:
  - If dotfiles: "Global settings (chezmoi)" / "Project settings (git hooks)" / "Cancel"
  - If regular: "Yes, set it up" / "Preview (--dry-run)" / "Cancel"

### Step 4: Execute Setup

```bash
# For project setup:
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" setup $ARGUMENTS

# For global/chezmoi setup:
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" --global setup $ARGUMENTS
```

### Step 5: Report Results

**For project settings:**
```
Setup complete!

Created:
  .claude/__settings.jsonc
  scripts/claude/settings-sync.sh
  scripts/git/block-settings-json.sh

Modified:
  lefthook.yml (added sync-settings, block-settings-json hooks)
  .gitattributes (added linguist-generated rule)

How it works:
  - Edit .claude/__settings.jsonc (supports // and /* */ comments)
  - On commit, changes auto-sync to settings.json
  - Direct edits to settings.json are blocked

Commands:
  /settings-sync      Manual sync
  /settings-check     Check if in sync (for CI)
  /settings-validate  Validate against schema
```

**For global settings (chezmoi):**
```
Chezmoi setup complete!

Created:
  dot_claude/__settings.jsonc
  run_onchange_after_claude-settings.sh.tmpl

Modified:
  .chezmoiignore

How it works:
  - Edit dot_claude/__settings.jsonc in your dotfiles
  - Run 'chezmoi apply' to sync to ~/.claude/settings.json
  - The run_onchange_ script triggers on content changes

Commands:
  settings-manager --global sync      Manual sync
  settings-manager --global check     Check if in sync
  settings-manager --global validate  Validate against schema
```
