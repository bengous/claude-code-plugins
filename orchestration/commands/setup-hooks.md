---
description: Install orchestration plugin hooks into project settings
argument-hint: "[--remove|--force|--dry-run]"
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Install plugin hooks into `.claude/settings.local.json` for automated workflow enforcement.

**⚠️ Why this command exists:**

Claude Code v2.0.13 doesn't automatically load hooks from plugins. This command installs them manually into project settings as a workaround. When Claude Code adds native plugin hook support, this command will no longer be necessary.

**What it installs:**

1. **worktree-guard** (PreToolUse:Bash) - Blocks raw `git worktree` commands

**Usage:**

```bash
# Install hooks (safe to run multiple times)
/setup-hooks

# Preview changes without applying
/setup-hooks --dry-run

# Force reinstall (overwrites existing)
/setup-hooks --force

# Remove plugin hooks
/setup-hooks --remove
```

**What happens:**

1. Validates plugin is installed
2. Backs up `.claude/settings.local.json` to `.backup`
3. Merges plugin hooks (preserves existing hooks)
4. Reports what was installed

**Example output:**

```
✅ Installed 1 hook from claude-orchestration plugin
   - PreToolUse:Bash → worktree-guard.py

📝 Backup saved: .claude/settings.local.json.backup
```

**Verification:**

After installation, test that hooks work:

```bash
# Should be blocked with helpful message
git worktree add /tmp/test
```

**Troubleshooting:**

- **"Plugin not installed"**: Run `/plugin` to install claude-orchestration
- **"Already installed"**: Hooks are present, use `--force` to reinstall
- **Settings not loading**: Restart Claude Code after installation

**Related:**

- Plugin structure at: `${CLAUDE_PLUGIN_ROOT}/`
- Hooks directory: `~/.claude/plugins/.../hooks/`
- Settings file: `.claude/settings.local.json`

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "$HOME/projects/claude-plugins/orchestration"`

**Your task:**

Execute the setup hooks script:

```bash
<plugin-location-from-above>/scripts/setup-hooks.js $ARGUMENTS
```

Show the full output to the user.