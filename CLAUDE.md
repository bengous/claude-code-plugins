# Claude Code Plugin Development Guide

This repository is a **plugin marketplace** for Claude Code. This guide teaches you how to create, test, and distribute plugins.

> **Note:** For documentation on specific plugins (orchestration, git-tools), see their individual README files.

---

## Core Principle: Keep It Simple

**DO NOT OVER-ENGINEER - KISS**. If the plugin tool you are working on is getting too big, stop and report to the human. You may be overdoing it.

---

## Plugin Structure Overview

### Required Files
- `.claude-plugin/plugin.json` - Plugin manifest (ONLY file in this directory)
- `commands/` - At least one command file (*.md)
- `README.md` - Plugin documentation
- `LICENSE` - License file

### Optional Directories
- `scripts/` - Backend implementation (bash scripts)
- `hooks/` - Safety/workflow enforcement
- `agents/` - Subagent templates
- `skills/` - Agent skills

### Critical Rules

**Essential requirements - violations will cause failures:**

1. **Only `plugin.json` in `.claude-plugin/`** - No other files allowed there
2. **Version sync required** - `marketplace.json` and `plugin.json` versions must match exactly
3. **No hardcoded paths** - Use `${CLAUDE_PLUGIN_ROOT}` or dynamic discovery (`git rev-parse --show-toplevel`)
4. **Repository-scoped state** - Store in `.plugin-name/` (in repo), NOT `$HOME`
5. **Atomic writes** - Use temp file + mv pattern for file updates
6. **Executable scripts** - All scripts must have `chmod +x`

---

## Reference Documentation

**When developing plugins, consult these detailed guides as needed:**

### Getting Started
- **[Quick Start](docs/references/quickstart.md)** - Create your first plugin in 5 steps
- **[Commands](docs/references/commands.md)** - Command development: frontmatter, path resolution, allowed-tools
- **[Scripts](docs/references/scripts.md)** - Script implementation: headers, patterns, helpers, utilities

### Advanced Features
- **[Hooks](docs/references/hooks.md)** - Hook system: registration, events, implementation, bypasses
- **[State Management](docs/references/state.md)** - Best practices: repository-scoped, per-item files, atomic writes
- **[Testing](docs/references/testing.md)** - Local development, debugging, diagnostic commands

### Best Practices
- **[Patterns](docs/references/patterns.md)** - Architectural patterns: delegation, routers, locks, idempotency
- **[Pitfalls](docs/references/pitfalls.md)** - Common mistakes: hardcoded paths, global state, non-atomic writes

### Distribution
- **[Marketplace](docs/references/distribution.md)** - Publishing: marketplace.json, version sync, installation

### Examples
- **[TODO Plugin](docs/examples/todo-plugin.md)** - Complete working example with all files

---

## When to Consult Which Reference

**Use this guide to find the right documentation:**

| Task | Reference |
|------|-----------|
| Creating first plugin | [Quick Start](docs/references/quickstart.md) |
| Writing slash commands | [Commands](docs/references/commands.md) |
| Implementing backend logic | [Scripts](docs/references/scripts.md) |
| Adding safety guards | [Hooks](docs/references/hooks.md) |
| Managing plugin state | [State Management](docs/references/state.md) |
| Testing/debugging issues | [Testing](docs/references/testing.md) |
| Choosing architecture | [Patterns](docs/references/patterns.md) |
| Avoiding mistakes | [Pitfalls](docs/references/pitfalls.md) |
| Publishing plugin | [Marketplace](docs/references/distribution.md) |
| Learning by example | [TODO Plugin](docs/examples/todo-plugin.md) |

---

## Existing Production Plugins

This marketplace contains production plugins for reference:

- **orchestration/** - Advanced workflow orchestration with worktrees, issues, PRs, and multi-agent coordination
- **git-tools/** - Interactive git commands with AI assistance

Each has its own README and documentation. Use them as architectural reference when building your plugins.

---

## Key Takeaways

1. **Separate concerns**: Commands delegate to scripts
2. **Dynamic discovery**: No hardcoded paths
3. **Repository-scoped state**: Store in `.plugin-name/`, not global
4. **Safety through hooks**: Enforce patterns, prevent mistakes
5. **Atomic operations**: Use temp files + mv
6. **Clear conventions**: Colors, errors, structure
7. **Idempotency**: Safe to retry
8. **Testability**: Support local development

Follow these patterns to create robust, maintainable plugins that integrate seamlessly with Claude Code.
