---
paths:
  - "**/marketplace.json"
  - "**/plugin.json"
---

# Marketplace Publishing

Publishing and distributing plugins via Claude Code marketplaces.

## Version Synchronization (CRITICAL)

Both versions **must match exactly**:

```json
// marketplace.json
{
  "plugins": [{
    "name": "my-plugin",
    "version": "1.0.0"  // ← Must match
  }]
}

// my-plugin/.claude-plugin/plugin.json
{
  "name": "my-plugin",
  "version": "1.0.0"  // ← Must match
}
```

**Why:** Version mismatch breaks installation and updates.

## Marketplace Structure

**marketplace.json:**
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

## plugin.json (Manifest)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Brief description of what this plugin does",
  "author": {
    "name": "Your Name",
    "email": "you@email.com"
  },
  "homepage": "https://github.com/you/my-plugin",
  "repository": "https://github.com/you/my-plugin",
  "license": "MIT",
  "keywords": ["relevant", "keywords"]
}
```

**IMPORTANT:** `.claude-plugin/` must contain ONLY `plugin.json`. Extra files cause silent discovery failures.

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

## Pre-Publish Checklist

- [ ] Version in `marketplace.json` matches `plugin.json`
- [ ] Only `plugin.json` exists in `.claude-plugin/`
- [ ] All scripts are executable (`chmod +x`)
- [ ] No hardcoded paths in commands or scripts
- [ ] README.md describes installation and usage
