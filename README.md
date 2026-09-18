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
| [claude-orchestration](orchestration/) | 2.8.1 | Parallel multi-agent orchestration for complex features with git-wt --stack worktree isolation |
| [git](git/) | 1.1.0 | Local history without an editor: commit with an optional issue-closing trailer, interactive rebase, squash by pattern or hash |
| [github-flow](github-flow/) | 1.7.1 | GitHub lifecycle through gh: agent-ready issues, review-ready PRs with attached images, issue and PR triage, CI-gated linear merge, commit-push-PR in one step, stacked PRs with gh stack, and an issue-to-PR loop whose worker agents land their own PR |
| [repo-bootstrap](repo-bootstrap/) | 1.0.2 | One-shot repo setup: the dev-trunk/main-release linear model, branches migrated to submodules with GitHub Actions sync |
| [code-quality](code-quality/) | 2.0.3 | Code quality and cleanup commands for maintaining clean, maintainable code |
| [clean-comments](clean-comments/) | 1.1.2 | Audit and clean code comments: protects why/constraint comments, hunts comments that lie |
| [mermaid-diagrams](mermaid-diagrams/) | 1.0.0 | Create and edit Mermaid diagrams for software engineering work, architectural ideas, and technical documentation |
| [claude-meta-tools](claude-meta-tools/) | 6.0.0 | Meta tooling for Claude Code: write prompts that prompt better (meta-prompt) |
| [context-management](context-management/) | 2.0.0 | Lifecycle of Claude Code instruction files: audit CLAUDE.md/AGENTS.md/.claude/rules instruction budget, capture session learnings, and resync docs with codebase evolution |
| [research-tools](research-tools/) | 1.2.1 | Documentation research through optimal MCP sources and claim verification: research agents, source routing, web and codebase fact-checking |
| [claude-settings-manager](claude-settings-manager/) | 1.1.2 | Manage Claude Code settings with JSONC support and schema extraction |
| [git-worktree](git-worktree/) | 1.2.1 | Git worktree helper with stack support for multi-agent orchestration |
| [agents-bridge](agents-bridge/) | 1.11.1 | Bridge to the OpenAI Codex CLI for cross-model collaboration |
| [software-craft](software-craft/) | 3.0.0 | Opinionated design skills for software excellence: CLI design, system architecture, and more |
| [understanding](understanding/) | 1.1.0 | Understand a topic, a bug, or a Claude Code workflow: minimal explanations, root-cause diagnosis, execution traces |
| [design-studio](design-studio/) | 1.1.1 | Generate 5 unique website redesigns using Theo's pattern: one agent, sequential creation, natural differentiation |
| [plugin-cache-sync](plugin-cache-sync/) | 2.2.2 | Sync Claude Code plugin cache from local sources |
| [git-sweep](git-sweep/) | 3.2.0 | Interactive git branch and worktree cleanup: proves a branch is contained before proposing it, frees finished worktrees, and reports what it kept and why |
| [goalify](goalify/) | 1.0.0 | Convert rough intent into the smallest useful goal payload to hand to a fresh Claude Code agent (new session, subagent, or /loop). Draft-first by default, or interactive question-first. |
| [architecture-audit](architecture-audit/) | 1.0.0 | Architecture audit that grants the existing code no authority: derive the requirements, design the minimal from-scratch architecture, then classify every component KEEP / SIMPLIFY / REPLACE / DELETE |
| [vellum](vellum/) | 0.6.0 | Plan at the frontiers and review the plan in the browser: open choices settled first, interfaces and files before mechanics, vertical slices each closed by a check; /vellum:start opens a planning mode of its own where Claude writes the plan and its mockups, the reviewer comments text, HTML elements and diagrams in a page or approves, and the answer reaches Claude as a prompt |

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
