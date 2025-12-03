# Claude Settings Manager

Manage Claude Code settings with JSONC support - add comments to your config files.

## Why?

Claude Code's `settings.json` is strict JSON - no comments allowed. But documentation matters! This plugin lets you:

- Use `__settings.jsonc` as your source of truth (with `//` and `/* */` comments)
- Auto-sync to `settings.json` on commit via git hooks
- Block accidental direct edits to `settings.json`

## Quick Start

```bash
# In your project directory
/settings-setup
```

That's it. The wizard will:
1. Create `.claude/__settings.jsonc` (copied from existing settings.json if present)
2. Set up git hooks (lefthook or husky)
3. Configure package.json scripts

## Commands

| Command | Description |
|---------|-------------|
| `/settings-setup` | Scaffold JSONC workflow in your project |
| `/settings-sync` | Manually sync __settings.jsonc to settings.json |
| `/settings-validate` | Validate against Claude Code schema |
| `/settings-check` | Check if files are in sync (for CI) |

## How It Works

### File Structure

After setup, your project has:

```
your-project/
├── .claude/
│   ├── __settings.jsonc     # Edit this (supports comments)
│   └── settings.json        # Generated (don't edit directly)
├── scripts/
│   ├── claude/
│   │   └── settings-sync.sh
│   └── git/
│       └── block-settings-json.sh
└── lefthook.yml             # or .husky/pre-commit
```

### Workflow

1. Edit `.claude/__settings.jsonc`
2. On commit, the pre-commit hook:
   - Blocks if you edited `settings.json` directly
   - Syncs `__settings.jsonc` to `settings.json`
   - Stages the updated `settings.json`

### Example __settings.jsonc

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
   * See hooks documentation for more examples
   */
  "hooks": {
    "PreToolUse": [
      // Add your hooks here
    ]
  }
}
```

## Manual Sync

```bash
# Using npm script
npm run claude:sync

# Or directly
./scripts/claude/settings-sync.sh

# Or via plugin
/settings-sync
```

## CI Integration

Add to your CI pipeline:

```yaml
- name: Check settings sync
  run: npm run claude:sync:check
```

Or:

```bash
./scripts/claude/settings-sync.sh
git diff --exit-code .claude/settings.json
```

## Emergency Bypass

If you absolutely need to commit settings.json directly:

```bash
SETTINGS_BYPASS=1 git commit -m "Emergency settings fix"
```

## Requirements

- Node.js (for JSONC parsing)
- Git
- lefthook or husky (lefthook recommended - zero deps)

## Options

```bash
/settings-setup --dry-run           # Preview changes
/settings-setup --force             # Overwrite existing files
/settings-setup --hook-system husky # Force husky instead of lefthook
```

## Troubleshooting

### "JSONC parse error"

Your `__settings.jsonc` has invalid syntax. Common issues:
- Trailing comma after last property
- Missing quotes around keys
- Unterminated string

### "settings.json blocked"

You edited `settings.json` directly. Options:
1. Discard changes: `git checkout .claude/settings.json`
2. Copy changes to `__settings.jsonc` and sync
3. Bypass (emergency): `SETTINGS_BYPASS=1 git commit ...`

### Hooks not running

- Lefthook: Run `lefthook install`
- Husky: Run `npx husky install`
