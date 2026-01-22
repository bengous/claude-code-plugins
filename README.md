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
| [claude-orchestration](orchestration/) | 2.4.0 | Parallel multi-agent orchestration for complex features with git-wt --stack worktree isolation |
| [git-tools](git-tools/) | 1.11.0 | Interactive git commands with AI assistance for commit management, history rewriting, PR/issue triage, agent-ready issue writing, and submodule automation |
| [code-quality](code-quality/) | 1.3.0 | Code quality and cleanup commands for maintaining clean, maintainable code |
| [mermaid-diagrams](mermaid-diagrams/) | 1.0.0 | Create and edit Mermaid diagrams for software engineering work, architectural ideas, and technical documentation |
| [claude-meta-tools](claude-meta-tools/) | 1.8.2 | Meta-tools for Claude Code: maintain documentation (CLAUDE.md sync), create skills, validate skill structure, prompt coaching/auditing, and extend Claude capabilities |
| [claude-settings-manager](claude-settings-manager/) | 1.1.0 | Manage Claude Code settings with JSONC support and schema extraction |
| [git-worktree](git-worktree/) | 1.2.0 | Git worktree helper with stack support for multi-agent orchestration |
| [plan-review](plan-review/) | 1.0.0 | Multi-agent plan review workflow requiring architect and simplifier approval before plan execution |
| [agents-bridge](agents-bridge/) | 1.0.0 | Bridge to external AI agents (Codex, Gemini CLI, etc.) for cross-model collaboration |
| [conductor](conductor/) | 1.1.0 | Conversational planning skill that produces self-contained implementation plans |
| [software-craft](software-craft/) | 1.0.1 | Opinionated design skills for software excellence: CLI design, system architecture, and more |

See each plugin's README for detailed documentation and usage.

## License

MIT License - See [LICENSE](LICENSE) for details.

## Author

**Augustin BENGOLEA** - [@bengous](https://github.com/bengous)
