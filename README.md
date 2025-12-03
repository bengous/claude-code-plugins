# Claude Code Plugins

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Plugins](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbengous%2Fclaude-code-plugins%2Fmain%2F.claude-plugin%2Fmarketplace.json&query=%24.plugins.length&label=plugins&color=blue)](https://github.com/bengous/claude-code-plugins)

A curated marketplace of Claude Code plugins for advanced development workflow automation.

## Installation

Add this marketplace to Claude Code:

```bash
/plugin marketplace add bengous/claude-code-plugins
```

Browse and install plugins:

```bash
# Browse available plugins interactively
/plugin

# Install a specific plugin
/plugin install claude-orchestration@bengolea-plugins
```

## Available Plugins

### 🎯 claude-orchestration (v0.1.1)

Advanced orchestration system for managing complex development workflows with intelligent task delegation, worktree isolation, and automated PR workflows.

**Key Features:**
- **32 Slash Commands** across 4 categories
- **Worktree Management** (19 commands) - Create isolated environments for parallel development
- **GitHub Integration** (8 issue commands, PR automation)
- **Task Orchestration** (/orc) - Multi-agent coordination with SIMPLE/MEDIUM/COMPLEX routing
- **Safety Hooks** (3 hooks) - Prevent mistakes with automated guards

**Installation:**
```bash
/plugin install claude-orchestration@bengolea-plugins
```

**Quick Start:**
```bash
# List all managed worktrees
/worktree

# Create isolated worktree for a feature
/worktree:create feature-name --issue 123

# Start orchestrated task (auto-routes to best execution path)
/orc:start "Implement user authentication with tests"

# Manage GitHub issues
/issue:list --state open
/issue:create "Bug: Fix login validation"
```

**Command Categories:**

| Category | Commands | Description |
|----------|----------|-------------|
| `/worktree:*` | 19 | Create, manage, and coordinate isolated git worktrees |
| `/issue:*` | 8 | GitHub issue operations (create, list, comment, label, etc.) |
| `/pr:*` | 2 | Pull request automation and workflow management |
| `/orc:*` | 2 | Multi-agent task orchestration with intelligent routing |

**Safety Features:**
- **Worktree Guard** - Prevents destructive git operations in managed worktrees
- **PR Guard** - Enforces COMPLEX mode PR targeting rules
- **Plan Mode Enforcer** - Ensures /orc:start uses planning phase

**Learn More:**
- [Plugin Homepage](https://github.com/bengous/claude-code-plugins)
- [Full Command Reference](https://github.com/bengous/claude-code-plugins/tree/main/orchestration/commands)

## Marketplace Structure

This repository follows the Claude Code marketplace structure:

```
.
├── .claude-plugin/
│   └── marketplace.json       # Marketplace catalog
├── orchestration/             # Plugin: claude-orchestration
│   ├── plugin.json           # Plugin manifest
│   ├── commands/             # 32 slash commands
│   ├── hooks/                # 3 safety hooks
│   ├── scripts/              # Helper scripts
│   └── LICENSE               # MIT License
└── README.md                 # This file
```

## For Plugin Users

**Browse Plugins:**
```bash
/plugin
```

**Update Marketplace:**
```bash
/plugin marketplace update bengolea-plugins
```

**Uninstall:**
```bash
/plugin uninstall claude-orchestration
```

## For Developers

Want to contribute or create your own plugin?

1. **Fork this repository**
2. **Create a new plugin directory** following the structure:
   ```
   my-plugin/
   ├── plugin.json
   ├── commands/
   └── LICENSE
   ```
3. **Add to marketplace.json** in `.claude-plugin/marketplace.json`
4. **Submit a PR** with your plugin

See [Claude Code Plugin Documentation](https://docs.claude.com/en/docs/claude-code/plugins) for development guide.

## License

MIT License - See [LICENSE](LICENSE) file for details.

Individual plugins may have their own licenses. See each plugin's LICENSE file.

## Author

**Augustin BENGOLEA**
- Email: bengous@protonmail.com
- GitHub: [@bengous](https://github.com/bengous)

## Support

- **Issues**: [GitHub Issues](https://github.com/bengous/claude-code-plugins/issues)
- **Discussions**: [GitHub Discussions](https://github.com/bengous/claude-code-plugins/discussions)

---

Built with ❤️ for the Claude Code community
