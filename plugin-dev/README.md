# plugin-dev

Dev tool for syncing Claude Code plugin cache from local sources.

**Version:** 1.0.0

## Why

The Claude Code plugin cache doesn't always refresh after commits or restarts. This tool clears stale cache entries and copies fresh files from your local source directory.

## Install

```
/plugin-dev:install
```

This symlinks (Linux/macOS) or copies (Windows) the `plugin-dev` CLI to `~/.local/bin/`.

## Usage

```bash
plugin-dev status                   # Show cache vs source comparison
plugin-dev sync <name>              # Sync a plugin (partial name match)
plugin-dev sync --all               # Sync all installed plugins
plugin-dev version                  # Print version
```

### Standalone Mode

Works without a registered directory-source marketplace:

```bash
# Auto-detect: run from a repo with .claude-plugin/marketplace.json
cd ~/my-plugins && plugin-dev sync --all

# Explicit source
plugin-dev --source ~/my-plugins sync --all
```

## Important

After syncing, **restart Claude Code** for changes to take effect. `/reload-plugins` is not sufficient.
