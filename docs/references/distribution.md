# Marketplace Distribution

[← Back to Main Guide](../../CLAUDE.md)

Publishing and distributing plugins via Claude Code marketplaces.

## Adding Plugin to Marketplace

**.claude-plugin/marketplace.json:**
```json
{
  "name": "my-marketplace",
  "owner": {
    "name": "Your Name",
    "email": "you@email.com"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "Plugin description",
      "version": "1.0.0",
      "author": {
        "name": "Your Name",
        "email": "you@email.com"
      },
      "homepage": "https://github.com/you/plugins",
      "license": "MIT",
      "keywords": ["keyword1", "keyword2"],
      "source": "./my-plugin"
    }
  ]
}
```

## Version Synchronization

**CRITICAL:** Both versions must match!

```json
# .claude-plugin/marketplace.json
{
  "plugins": [{
    "name": "my-plugin",
    "version": "1.0.0"  # ← Must match
  }]
}

# my-plugin/.claude-plugin/plugin.json
{
  "name": "my-plugin",
  "version": "1.0.0"  # ← Must match
}
```

## Installation

Users add your marketplace:

```bash
/plugin marketplace add your-github-user/plugin-repo
/plugin install my-plugin@my-marketplace
```

Or for team installations, add to `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "team-tools": {
      "source": {
        "source": "github",
        "repo": "your-org/plugins"
      }
    }
  },
  "enabledPlugins": ["my-plugin@team-tools"]
}
```

---

**Related:**
- [Quick Start](./quickstart.md) - Creating your first plugin
- [Pitfalls](./pitfalls.md) - Version desync mistakes
