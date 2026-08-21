---
name: plugin-cache-sync-usage
description: Show plugin-cache-sync status and explain sync workflow
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
---

# plugin-cache-sync

Sync Claude Code plugin cache from local sources.

To test a plugin under edit, prefer `claude --plugin-dir /path/to/plugin`: it reads
the source directly, needs no version bump, and writes nothing to the cache. Use
`sync` only to make an edit live in ordinary sessions launched without flags.

## Current Status

!`"${CLAUDE_PLUGIN_ROOT}/scripts/plugin-cache-sync" version 2>&1 || echo "(plugin-cache-sync not available)"`

!`"${CLAUDE_PLUGIN_ROOT}/scripts/plugin-cache-sync" status 2>&1 || echo "(could not get status)"`

## Workflow

1. **Check status**: `plugin-cache-sync status` — shows which plugins are stale and which are enabled
2. **Sync one plugin**: `plugin-cache-sync sync <name>` — partial name match (e.g. `plugin-cache-sync sync meta`)
3. **Sync all**: `plugin-cache-sync sync --all`
4. **Enable a new plugin**: `claude plugin enable <name>@<marketplace>` — `sync` does not touch `settings.json`, so a brand-new plugin must be enabled once before Claude Code will load it
5. **Restart Claude Code** — `/reload-plugins` reports success and keeps serving the definitions loaded at startup, so a synced change stays invisible until you restart

> `sync` warns when a plugin is synced but not enabled.

## Standalone Mode

For repos not registered as a known marketplace:

- **CWD auto-detection**: if `$PWD/.claude-plugin/marketplace.json` exists, plugin-cache-sync uses it automatically
- **Explicit source**: `plugin-cache-sync --source /path/to/repo sync --all`

## Installation

Run `/plugin-cache-sync:install` to add `plugin-cache-sync` to your PATH.
On Windows, run `/plugin-cache-sync:update` after plugin updates to re-copy the script.

## Key Paths

| Path | Purpose |
|------|---------|
| `~/.claude/plugins/cache/` | Plugin cache (what plugin-cache-sync syncs) |
| `~/.claude/plugins/installed_plugins.json` | Installed plugin registry |
| `~/.claude/plugins/known_marketplaces.json` | Marketplace sources |
