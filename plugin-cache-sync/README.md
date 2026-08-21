# plugin-cache-sync

Sync Claude Code plugin cache from local sources.

**Version:** 2.2.0

## Why

Claude Code copies a directory-source plugin into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. The cache path is keyed by version. Edit a source file without bumping the version and nothing refreshes the cache: not `/reload-plugins`, not `/reload-plugins --force`, not a full restart.

This tool force-copies the source over the cache so the next session loads your edits.

## When not to use it

To test a plugin you are editing, use the flag Anthropic documents instead:

```bash
claude --plugin-dir /path/to/my-plugin
```

That reads the source directly, ignores the cache, and needs no version bump. Use `plugin-cache-sync` only when you want an edit live in your ordinary sessions, without launching with flags.

## Install

```
/plugin-cache-sync:install
```

This symlinks (Linux/macOS) or copies (Windows) the `plugin-cache-sync` CLI to `~/.local/bin/`.

## Usage

```bash
plugin-cache-sync status                   # Show cache vs source comparison (incl. enabled state)
plugin-cache-sync sync <name>              # Sync a plugin (partial name match)
plugin-cache-sync sync --all               # Sync all installed plugins
plugin-cache-sync version                  # Print version
```

`status` compares the cached files with the plugin source. The recorded Git SHA
is provenance only, so unrelated repository commits do not mark plugins stale.

### Enabling plugins

`sync` writes the plugin cache and registry but does **not** touch
`~/.claude/settings.json`. Claude Code only loads a plugin listed in
`enabledPlugins`, so a brand-new plugin that has never been enabled syncs
successfully yet never loads. Enable it with the official CLI:

```bash
claude plugin enable <name>@<marketplace>
```

`status` shows the current enabled state, and `sync` warns when a synced plugin is not enabled.

### Standalone Mode

Works without a registered directory-source marketplace:

```bash
# Auto-detect: run from a repo with .claude-plugin/marketplace.json
cd ~/my-plugins && plugin-cache-sync sync --all

# Explicit source
plugin-cache-sync --source ~/my-plugins sync --all
```

## Automatic checks

Two hooks check what you edit. Both read the source directory on disk, so they see an
edit the moment it lands — no sync, no restart, no cache involved.

| Event | Scope | Check | Cost |
|-------|-------|-------|------|
| `PostToolUse` on `Edit\|Write` | the plugin holding the written file | `claude plugin validate --strict` | ~0.3 s |
| `Stop` | every plugin with uncommitted changes | validate, then `claude --plugin-dir <dir> plugin details <name>` | ~1 s cold, ~20 ms warm |

A failure exits 2, so the reason reaches Claude, which fixes it and keeps working. The
turn never ends on a plugin that fails to validate or to load. `Stop` results are keyed
by a content hash, so an unchanged plugin is never re-checked.

These hooks never write. They do not sync, and they do not make an edit live in the
running session — nothing can, short of a restart. They answer one question: is what you
just wrote valid and loadable?

Neither check proves the plugin *behaves*. For that, write eval cases and run
`claude plugin eval <dir>`.

## Important

After syncing, **restart Claude Code**. `/reload-plugins` reports success and keeps serving the definitions it loaded at startup, so a synced change stays invisible until you restart.
