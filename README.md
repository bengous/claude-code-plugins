# Claude Code Plugins

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A curated marketplace of Claude Code plugins for development workflow automation.

## Installation

```bash
# Add this marketplace to Claude Code
/plugin marketplace add bengous/claude-code-plugins

# Install a plugin
/plugin install <plugin-name>@bengous-plugins
```

## Available Plugins

| Plugin | Version | Description |
|--------|---------|-------------|
| [claude-orchestration](orchestration/) | 2.5.1 | Parallel multi-agent orchestration for complex features with git-wt --stack worktree isolation |
| [git-tools](git-tools/) | 1.11.0 | Interactive git commands with AI assistance for commit management, history rewriting, PR/issue triage, agent-ready issue writing, and submodule automation |
| [code-quality](code-quality/) | 1.4.0 | Code quality and cleanup commands for maintaining clean, maintainable code |
| [mermaid-diagrams](mermaid-diagrams/) | 1.0.0 | Create and edit Mermaid diagrams for software engineering work, architectural ideas, and technical documentation |
| [claude-meta-tools](claude-meta-tools/) | 1.10.0 | Meta-tools for Claude Code: maintain documentation (CLAUDE.md sync), create skills, validate skill structure, prompt coaching/auditing, and extend Claude capabilities |
| [claude-settings-manager](claude-settings-manager/) | 1.1.0 | Manage Claude Code settings with JSONC support and schema extraction |
| [git-worktree](git-worktree/) | 1.2.0 | Git worktree helper with stack support for multi-agent orchestration |
| [plan-review](plan-review/) | 1.0.1 | Multi-agent plan review workflow requiring architect and simplifier approval before plan execution |
| [agents-bridge](agents-bridge/) | 1.2.0 | Bridge to external AI agents (Codex, Gemini CLI, etc.) for cross-model collaboration |
| [conductor](conductor/) | 1.3.5 | Conversational planning skill that produces self-contained implementation plans |
| [software-craft](software-craft/) | 1.0.1 | Opinionated design skills for software excellence: CLI design, system architecture, and more |

See each plugin's README for detailed documentation and usage.

## Development Setup

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/bengous/claude-code-plugins.git
cd claude-code-plugins

# Install tools and hooks
mise install && lefthook install
```

Requires [mise](https://mise.jdx.dev) for tool management.

## License

MIT License - See [LICENSE](LICENSE) for details.

## Author

**Augustin BENGOLEA** - [@bengous](https://github.com/bengous)
