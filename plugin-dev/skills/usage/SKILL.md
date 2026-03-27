---
name: plugin-dev-usage
description: Show plugin-dev status and explain sync workflow
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
---

# plugin-dev

Dev tool for syncing Claude Code plugin cache from local sources.

## Current Status

!`"${CLAUDE_PLUGIN_ROOT}/scripts/plugin-dev" version 2>&1 || echo "(plugin-dev not available)"`

!`"${CLAUDE_PLUGIN_ROOT}/scripts/plugin-dev" status 2>&1 || echo "(could not get status)"`

## Workflow

1. **Check status**: `plugin-dev status` — shows which plugins are stale
2. **Sync one plugin**: `plugin-dev sync <name>` — partial name match (e.g. `plugin-dev sync meta`)
3. **Sync all**: `plugin-dev sync --all`
4. **Restart Claude Code** — required after sync (`/reload-plugins` is not sufficient)

## Standalone Mode

For repos not registered as a known marketplace:

- **CWD auto-detection**: if `$PWD/.claude-plugin/marketplace.json` exists, plugin-dev uses it automatically
- **Explicit source**: `plugin-dev --source /path/to/repo sync --all`

## Installation

Run `/plugin-dev:install` to add `plugin-dev` to your PATH.
On Windows, run `/plugin-dev:update` after plugin updates to re-copy the script.

## Key Paths

| Path | Purpose |
|------|---------|
| `~/.claude/plugins/cache/` | Plugin cache (what plugin-dev syncs) |
| `~/.claude/plugins/installed_plugins.json` | Installed plugin registry |
| `~/.claude/plugins/known_marketplaces.json` | Marketplace sources |
