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
| [claude-orchestration](orchestration/) | 2.7.0 | Parallel multi-agent orchestration for complex features with git-wt --stack worktree isolation |
| [git-tools](git-tools/) | 1.11.4 | Interactive git commands with AI assistance for commit management, history rewriting, PR/issue triage, agent-ready issue writing, and submodule automation |
| [code-quality](code-quality/) | 2.0.0 | Code quality and cleanup commands for maintaining clean, maintainable code |
| [clean-comments](clean-comments/) | 1.0.0 | Audit and clean code comments: protects why/constraint comments, hunts comments that lie |
| [mermaid-diagrams](mermaid-diagrams/) | 1.0.0 | Create and edit Mermaid diagrams for software engineering work, architectural ideas, and technical documentation |
| [claude-meta-tools](claude-meta-tools/) | 5.0.0 | Prompt tooling for Claude Code: write and audit prompts (meta-prompt, prompt-coach, prompt-health) and introspect how the harness executes them (dump-system-prompt, explain-workflow) |
| [context-management](context-management/) | 1.0.0 | Lifecycle of Claude Code instruction files: audit CLAUDE.md/AGENTS.md/.claude/rules instruction budget, capture session learnings, and resync docs with codebase evolution |
| [research-tools](research-tools/) | 1.1.0 | Documentation research through optimal MCP sources and claim verification: research agents, source routing, web and codebase fact-checking |
| [claude-settings-manager](claude-settings-manager/) | 1.1.0 | Manage Claude Code settings with JSONC support and schema extraction |
| [git-worktree](git-worktree/) | 1.2.0 | Git worktree helper with stack support for multi-agent orchestration |
| [plan-review](plan-review/) | 1.1.0 | Multi-agent plan review workflow requiring architect and simplifier approval before plan execution |
| [agents-bridge](agents-bridge/) | 1.9.1 | Bridge to the OpenAI Codex CLI for cross-model collaboration |
| [conductor](conductor/) | 1.3.6 | Conversational planning skill that produces self-contained implementation plans |
| [software-craft](software-craft/) | 2.0.0 | Opinionated design skills for software excellence: CLI design, system architecture, and more |
| [understanding](understanding/) | 1.0.0 | Understand a topic or a bug: minimal explanations and root-cause diagnosis |
| [plugin-dev](plugin-dev/) | 1.2.0 | Dev tool for syncing Claude Code plugin cache from local sources |
| [git-sweep](git-sweep/) | 2.0.0 | Interactive git branch and worktree cleanup: proves a branch is contained before proposing it, frees finished worktrees, and reports what it kept and why |
| [ship](ship/) | 1.0.1 | Ship feature branches: strip working files, create PRs, merge to main with GPG signing and squash support |

See each plugin's README for detailed documentation and usage.

## Documentation

- [LSP Tools Setup](docs/lsp-tools-setup.md) - Enable semantic code navigation with Language Server Protocol
- [Plugin Design Philosophy](docs/plugin-design-philosophy.md) - Design principles for Claude Code plugins

## Development Setup

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/bengous/claude-code-plugins.git
cd claude-code-plugins

# Install tools and hooks
mise install && lefthook install
```

Requires [mise](https://mise.jdx.dev) for tool management.

After committing and pushing a plugin change, deploy exact installed plugins:

```bash
scripts/publish-live <plugin-name>...
```

The publisher refuses dirty or unpushed repositories and never installs or
enables a plugin implicitly.

## License

MIT License - See [LICENSE](LICENSE) for details.

## Author

**Augustin BENGOLEA** - [@bengous](https://github.com/bengous)
