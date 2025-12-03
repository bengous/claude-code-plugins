# Claude Settings Manager

Manage Claude Code settings with JSONC support - add comments to your config files.

## Why?

Claude Code's `settings.json` is strict JSON - no comments allowed. This plugin lets you:

- Use `__settings.jsonc` as your source of truth (with `//` and `/* */` comments)
- Auto-sync to `settings.json` via git hooks or chezmoi
- Block accidental direct edits to `settings.json`

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
| `/settings-sync` | Manually sync JSONC to JSON |
| `/settings-check` | Check if files are in sync (for CI) |
| `/settings-validate` | Validate against Claude Code schema |

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

## Manual Usage (Without Slash Commands)

The `settings-manager` script can be used directly:

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
settings-manager validate \
  --source .claude/__settings.jsonc
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

## Troubleshooting

### "JSONC parse error"

Your `__settings.jsonc` has invalid syntax. Common issues:
- Trailing comma after last property
- Missing quotes around keys
- Unterminated string or comment

### "settings.json blocked"

You edited `settings.json` directly. Options:
1. Discard: `git checkout .claude/settings.json`
2. Copy changes to `__settings.jsonc` and sync
3. Bypass: `SETTINGS_BYPASS=1 git commit ...`

### Hooks not running

- Lefthook: Run `lefthook install`
- Husky: Run `npx husky install`
- Chezmoi: Ensure `run_onchange_` script has execute permission
