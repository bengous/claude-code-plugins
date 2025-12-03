---
description: Set up JSONC workflow for Claude Code settings
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager":*)
  - Bash(ls:*)
  - Read(*:*)
  - Glob(*:*)
  - Grep(*:*)
  - AskUserQuestion(*:*)
model: claude-opus-4-5
---

# Settings Setup Wizard

You are setting up a JSONC workflow for Claude Code settings in this repository.

## The JSONC Workflow

Claude Code's `settings.json` doesn't support comments. This workflow:
1. Maintains `__settings.jsonc` as the editable source (supports `//` and `/* */` comments)
2. Auto-generates `settings.json` via hooks
3. Blocks direct edits to prevent drift

## Your Task

### Step 1: Analyze the Repository

Explore the repo to understand its structure. Check:

1. **Repo type detection:**
   - Is there a `.chezmoi.yaml.tmpl`, `.chezmoi.toml.tmpl`, or `.chezmoiroot`? (chezmoi dotfiles)
   - Are there `dot_*` prefixed directories? (chezmoi dotfiles)
   - Is there a `stow` or package-based structure? (stow dotfiles)
   - Otherwise: regular project repo

2. **Existing settings:**
   - Does `.claude/settings.json` exist?
   - Does `~/.claude/settings.json` exist (global)?
   - Is there already a `__settings.jsonc` file?

3. **Hook system:**
   - Is there a `lefthook.yml` or `lefthook.yaml`?
   - Is there a `.husky/` directory?
   - For chezmoi: hooks aren't needed (uses run_onchange_)

4. **Project structure:**
   - What's the scripts directory pattern? (scripts/, bin/, etc.)
   - Is there a `package.json`?

Use `ls`, `Glob`, and `Read` to explore. Example commands:
```bash
ls -la
ls -la .claude/ 2>/dev/null || echo "No .claude directory"
```

### Step 2: Determine Configuration

Based on your analysis, determine the appropriate flags:

**For regular projects:**
- `--source .claude/__settings.jsonc`
- `--target .claude/settings.json`
- `--hook-system lefthook` (or `husky` if `.husky/` exists)
- `--scripts-path scripts/claude`

**For chezmoi dotfiles:**
- `--source dot_claude/__settings.jsonc`
- `--target dot_claude/settings.json`
- `--hook-system chezmoi`
- `--install-global` (optional, installs settings-manager to PATH)

**For stow dotfiles:**
- `--source <package>/__settings.jsonc` (e.g., `claude/__settings.jsonc`)
- `--target <package>/settings.json`
- `--hook-system lefthook`
- `--scripts-path <package>/scripts`

### Step 3: Ask User if Unclear

Use `AskUserQuestion` to clarify ambiguous situations:

**If repo type is unclear:**
```
Question: "What type of settings are you configuring?"
Options:
- "Project settings (.claude/settings.json for this repo)"
- "Global settings (~/.claude/settings.json via dotfiles)"
```

**If both lefthook and husky exist:**
```
Question: "Which hook system should I use?"
Options:
- "lefthook"
- "husky"
```

**If dotfiles structure is ambiguous:**
```
Question: "Where should the settings files be created?"
Options:
- [suggest based on structure]
```

### Step 4: Present Plan and Confirm

Before executing, show the user:

```
I'll set up JSONC settings with:
  Source:      <path>
  Target:      <path>
  Hook system: <type>
  Scripts:     <path>

Files to create:
  - <source path> (JSONC with comments)
  - <scripts path>/settings-sync.sh (sync script)
  - <scripts path>/../git/block-settings-json.sh (block script)

Files to modify:
  - <hook config file>
  - .gitattributes
```

Use `AskUserQuestion` to confirm:
```
Question: "Proceed with this setup?"
Options:
- "Yes, create the files"
- "Preview first (dry-run)"
- "Cancel"
```

### Step 5: Execute Setup

Run the settings-manager script with your determined flags:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" setup \
  --source <source_path> \
  --target <target_path> \
  --hook-system <type> \
  --scripts-path <scripts_path>
```

Add `--dry-run` for preview mode.
Add `--install-global` for chezmoi setups if user wants it in PATH.

### Step 6: Report Results

Explain what was created and provide next steps:

**For git hooks (lefthook/husky):**
```
Setup complete!

Created:
  <source path>
  <scripts created>

How it works:
  1. Edit <source path> (supports // and /* */ comments)
  2. Commit your changes - the hook auto-syncs to settings.json
  3. Direct edits to settings.json are blocked

Manual sync: /settings-sync
Check sync:  /settings-check
Validate:    /settings-validate
```

**For chezmoi:**
```
Setup complete!

Created:
  <source path>
  run_onchange_after_claude-settings.sh.tmpl

How it works:
  1. Edit <source path> in your dotfiles
  2. Run 'chezmoi apply' - the run_onchange script syncs
  3. Changes deploy to ~/.claude/settings.json

Manual sync: settings-manager sync --source ~/.claude/__settings.jsonc --target ~/.claude/settings.json
```

## Important Guidelines

- **Always explore before deciding** - Read actual files to understand the structure
- **Ask the user if anything is ambiguous** - Don't guess
- **Show the plan before executing** - Let user confirm or adjust
- **The script handles file creation** - You handle decision-making
- **Never run setup without user confirmation**
