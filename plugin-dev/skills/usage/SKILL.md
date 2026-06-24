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

1. **Check status**: `plugin-dev status` — shows which plugins are stale and which are enabled
2. **Sync one plugin**: `plugin-dev sync <name>` — partial name match (e.g. `plugin-dev sync meta`)
3. **Sync all**: `plugin-dev sync --all`
4. **Enable a new plugin**: `plugin-dev enable <name>` (or `--all`) — `sync` does not touch `settings.json`, so a brand-new plugin must be enabled once before Claude Code will load it (`disable` to turn off)
5. **Restart Claude Code** — required after sync/enable (`/reload-plugins` is not sufficient)

> `sync` warns when a plugin is synced but not enabled. Enabling writes the live
> `~/.claude/settings.json` (the same file `/plugin` writes).

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
