# Quick Start: Create Your First Plugin

[← Back to Main Guide](../../CLAUDE.md)

This guide walks you through creating your first Claude Code plugin from scratch.

## 1. Create Directory Structure

```bash
mkdir -p my-plugin/.claude-plugin
mkdir -p my-plugin/commands
mkdir -p my-plugin/scripts/mycommand
```

## 2. Create Plugin Manifest

**my-plugin/.claude-plugin/plugin.json:**
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My first Claude Code plugin",
  "author": {
    "name": "Your Name",
    "email": "you@email.com"
  },
  "license": "MIT",
  "keywords": ["example"]
}
```

## 3. Create a Command

**my-plugin/commands/hello.md:**
```markdown
---
description: Say hello to the user
argument-hint: [name]
allowed-tools:
  - Bash(*:*)
---

Simple hello command.

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/your-marketplace/my-plugin 2>/dev/null || echo "$HOME/dev/my-plugin"`

Execute: `<plugin-location>/scripts/mycommand/mycommand hello $ARGUMENTS`
```

## 4. Create Backend Script

**my-plugin/scripts/mycommand/mycommand:**
```bash
#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
NC='\033[0m'

COMMAND="${1:-hello}"
shift || true

case "$COMMAND" in
  hello)
    name="${1:-World}"
    echo -e "${GREEN}Hello, $name!${NC}"
    ;;
  *)
    echo "Error: unknown command: $COMMAND" >&2
    exit 1
    ;;
esac
```

Make it executable: `chmod +x my-plugin/scripts/mycommand/mycommand`

## 5. Test Locally

```bash
cd /any/repository
/hello           # Output: Hello, World!
/hello Alice     # Output: Hello, Alice!
```

Claude Code automatically detects plugins in your repository. No build step required!

---

**Next steps:**
- [Plugin Structure](../../CLAUDE.md#plugin-structure-overview) - Understanding the plugin anatomy
- [Commands Guide](./commands.md) - Creating more complex commands
- [Scripts Guide](./scripts.md) - Best practices for backend scripts
