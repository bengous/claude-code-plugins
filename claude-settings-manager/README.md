# Claude Settings Manager

Manage Claude Code settings with JSONC support - add comments to your config files.

## Why?

Claude Code's `settings.json` is strict JSON - no comments allowed. This plugin lets you:

- Use `__settings.jsonc` as your source of truth (with `//` and `/* */` comments)
- Auto-sync to `settings.json` via git hooks or chezmoi
- Block accidental direct edits to `settings.json`
- Get AI-powered error explanations when validation fails

## Quick Start

```bash
/settings-setup
```

The wizard will:
1. Analyze your repository structure
2. Ask clarifying questions if needed
3. Set up the appropriate workflow (git hooks or chezmoi)

## How It Works

### Agentic Approach

This plugin uses a hybrid approach:
- **Claude decides**: Analyzes your repo, determines configuration, asks when unclear
- **Script executes**: The `settings-manager` script handles file creation based on explicit flags

This enables support for any setup: project repos, chezmoi dotfiles, stow dotfiles, or custom configurations.

### AI Error Explanation

When validation fails, the plugin can spawn headless Claude to explain the error:

```
Validation errors:
  - Unknown hook event: PreToolCall

┌─ AI Analysis ─────────────────────────────────────┐
│ The hook event "PreToolCall" is invalid. Claude   │
│ Code uses "PreToolUse" not "PreToolCall".         │
│                                                   │
│ Fix line 12:                                      │
│   "PreToolUse": [  // was: "PreToolCall"          │
└───────────────────────────────────────────────────┘
```

AI explanation is enabled automatically in generated hooks. You can also use it manually:

```bash
# Via flag
settings-manager validate --source .claude/__settings.jsonc --ai-explain

# Via environment variable
SETTINGS_AI_EXPLAIN=1 settings-manager validate --source .claude/__settings.jsonc
```

### Supported Repo Types

| Type | Source | Target | Trigger |
|------|--------|--------|---------|
| Regular project | `.claude/__settings.jsonc` | `.claude/settings.json` | Git pre-commit hook |
| Chezmoi dotfiles | `dot_claude/__settings.jsonc` | `~/.claude/settings.json` | `run_onchange_` script |
| Stow dotfiles | `<package>/__settings.jsonc` | `<package>/settings.json` | Git pre-commit hook |

## Commands

| Command | Description |
|---------|-------------|
| `/settings-setup` | Interactive wizard - analyzes repo and sets up workflow |
| `/settings-schema` | Extract and analyze Claude Code settings schema |

For sync, check, and validate operations, use `settings-manager` directly (see Manual Usage below).

## Example __settings.jsonc

```jsonc
// Claude Code Settings
// See: https://docs.anthropic.com/en/docs/claude-code/settings

{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",

  // Permissions for tool usage
  "permissions": {
    "allow": [
      "Bash(git:*)",      // All git commands
      "Read(*:*)",        // Read any file
      "WebSearch"         // Web searches
    ],
    "deny": [
      "Bash(rm -rf:*)"    // Never allow recursive delete
    ]
  },

  /*
   * Custom hooks for workflow enforcement
   */
  "hooks": {
    "PreToolUse": [
      // Add your hooks here
    ]
  }
}
```

## Manual Usage

The `settings-manager` script can be used directly without slash commands.

### Setup

```bash
# Regular project with lefthook
settings-manager setup \
  --source .claude/__settings.jsonc \
  --target .claude/settings.json \
  --hook-system lefthook

# Chezmoi dotfiles
settings-manager setup \
  --source dot_claude/__settings.jsonc \
  --target dot_claude/settings.json \
  --hook-system chezmoi \
  --install-global

# Stow dotfiles
settings-manager setup \
  --source claude/__settings.jsonc \
  --target claude/settings.json \
  --hook-system lefthook \
  --scripts-path claude/scripts

# No hooks (manual sync only)
settings-manager setup \
  --source .claude/__settings.jsonc \
  --target .claude/settings.json \
  --hook-system none
```

### Sync

```bash
settings-manager sync \
  --source .claude/__settings.jsonc \
  --target .claude/settings.json
```

### Check

```bash
settings-manager check \
  --source .claude/__settings.jsonc \
  --target .claude/settings.json
```

### Validate

```bash
# Basic validation
settings-manager validate \
  --source .claude/__settings.jsonc

# With AI error explanation
settings-manager validate \
  --source .claude/__settings.jsonc \
  --ai-explain
```

### Schema Extraction

Extract schema definitions from Claude Code's npm package:

```bash
# Extract latest version
settings-manager schema-extract

# Extract specific version
settings-manager schema-extract --version 2.0.62

# Output to specific directory
settings-manager schema-extract --output-dir docs/schema/

# Output format: json, md, or both (default)
settings-manager schema-extract --format md
```

Output files:
- `claude-code-{VERSION}.schema.json` - Extracted JSON Schema
- `claude-code-{VERSION}-reference.md` - Markdown documentation
- `describe-strings-{VERSION}.json` - Raw extracted data

### Schema Comparison

Compare schemas between versions or against schemastore.org:

```bash
# Find undocumented settings (compare latest vs schemastore.org)
settings-manager schema-diff

# Compare two specific versions
settings-manager schema-diff --base 2.0.50 --compare 2.0.62

# Output as JSON
settings-manager schema-diff --json
```

## Setup Flags Reference

| Flag | Required | Description |
|------|----------|-------------|
| `--source PATH` | Yes | Path to create `__settings.jsonc` |
| `--target PATH` | Yes | Path where `settings.json` will be generated |
| `--hook-system TYPE` | Yes | `lefthook`, `husky`, `chezmoi`, or `none` |
| `--scripts-path PATH` | No | Where to put helper scripts (default: `scripts/claude`) |
| `--install-global` | No | Install `settings-manager` to `~/.local/bin` |
| `--dry-run` | No | Preview changes without applying |
| `--force` | No | Overwrite existing files |

## File Structure

### Regular Project (lefthook/husky)

```
your-project/
├── .claude/
│   ├── __settings.jsonc     # Edit this (supports comments)
│   └── settings.json        # Generated (don't edit)
├── scripts/
│   ├── claude/
│   │   └── settings-sync.sh
│   └── git/
│       └── block-settings-json.sh
├── lefthook.yml             # or .husky/pre-commit
└── .gitattributes
```

### Chezmoi Dotfiles

```
your-dotfiles/
├── dot_claude/
│   └── __settings.jsonc     # Edit this (chezmoi source)
├── run_onchange_after_claude-settings.sh.tmpl
└── .chezmoiignore
```

## CI Integration

```yaml
- name: Check settings sync
  run: |
    settings-manager check \
      --source .claude/__settings.jsonc \
      --target .claude/settings.json
```

## Emergency Bypass

If you need to commit `settings.json` directly:

```bash
SETTINGS_BYPASS=1 git commit -m "Emergency settings fix"
```

## Requirements

- Node.js (for JSONC parsing)
- Git (for hook-based workflows)
- lefthook, husky, or chezmoi (depending on your setup)
- Claude Code CLI (optional, for AI error explanations)

## Troubleshooting

### "JSONC parse error"

Your `__settings.jsonc` has invalid syntax. Common issues:
- Trailing comma after last property
- Missing quotes around keys
- Unterminated string or comment

With AI explanation enabled, you'll get a detailed fix suggestion.

### "settings.json blocked"

You edited `settings.json` directly. Options:
1. Discard: `git checkout .claude/settings.json`
2. Copy changes to `__settings.jsonc` and sync
3. Bypass: `SETTINGS_BYPASS=1 git commit ...`

### Hooks not running

- Lefthook: Run `lefthook install`
- Husky: Run `npx husky install`
- Chezmoi: Ensure `run_onchange_` script has execute permission

### AI explanation not showing

- Ensure Claude Code CLI is installed: `which claude`
- Check the flag: `--ai-explain` or `SETTINGS_AI_EXPLAIN=1`
- Generated hooks enable this automatically
