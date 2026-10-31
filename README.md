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
| [claude-orchestration](orchestration/) | 2.8.3 | Parallel multi-agent orchestration for complex features with Task-based coordination and git-wt --stack worktree isolation |
| [git](git/) | 1.2.0 | Local history without an editor: commit with an optional issue-closing trailer, interactive rebase, squash by pattern or hash, GPG re-signing of past commits |
| [github-flow](github-flow/) | 3.0.0 | GitHub lifecycle through gh: agent-ready issues, review-ready PRs that show the change in diagrams, images and video, issue and PR triage, CI-gated linear merge, commit-push-PR in one step, stacked PRs with gh stack, and an issue-to-PR loop whose workers land their own low-tier PR |
| [repo-bootstrap](repo-bootstrap/) | 1.0.5 | One-shot repo setup: the dev-trunk/main-release linear model, branches migrated to submodules with GitHub Actions sync |
| [code-quality](code-quality/) | 2.1.0 | Code quality and cleanup commands for maintaining clean, maintainable code |
| [clean-comments](clean-comments/) | 1.1.3 | Audit and clean code comments: protects why/constraint comments, hunts comments that lie |
| [mermaid-diagrams](mermaid-diagrams/) | 1.0.2 | Create and edit Mermaid diagrams for software engineering work, architectural ideas, and technical documentation |
| [claude-meta-tools](claude-meta-tools/) | 7.1.0 | Meta tooling for Claude Code: write prompts that prompt better (meta-prompt) and aim them higher (ambition) |
| [context-management](context-management/) | 2.0.3 | Lifecycle of Claude Code instruction files: audit CLAUDE.md/AGENTS.md/.claude/rules instruction budget, capture session learnings, and resync docs with codebase evolution |
| [research-tools](research-tools/) | 1.2.4 | Documentation research through optimal MCP sources and claim verification: research agents, source routing, web and codebase fact-checking |
| [claude-settings-manager](claude-settings-manager/) | 1.1.4 | Manage Claude Code settings with JSONC support and schema extraction |
| [git-worktree](git-worktree/) | 1.2.2 | Git worktree helper with stack support for multi-agent orchestration |
| [agents-bridge](agents-bridge/) | 1.12.3 | Bridge to the OpenAI Codex CLI for cross-model collaboration |
| [software-craft](software-craft/) | 3.0.2 | Opinionated design skills for software excellence: CLI design, system architecture, and more. Skills that push Claude toward intentional, high-quality output instead of generic patterns. |
| [understanding](understanding/) | 1.2.0 | Understand a topic, a bug, a Claude Code workflow, or the last reply: minimal explanations, root-cause diagnosis, execution traces, layered recaps |
| [design-studio](design-studio/) | 1.1.3 | Generate 5 unique website redesigns using Theo's pattern: one agent, sequential creation, natural differentiation |
| [plugin-cache-sync](plugin-cache-sync/) | 2.2.4 | Sync Claude Code plugin cache from local sources |
| [git-sweep](git-sweep/) | 3.5.1 | Git branch and worktree cleanup that proves a branch is contained before deleting it and reports what it kept and why: an interactive sweep that asks first, and an unattended one that frees finished agent worktrees and archives abandoned agent branches under refs/archive/ |
| [goalify](goalify/) | 2.0.0 | Turn a rough task into the completion condition a /goal evaluator can judge: end state, proof command, constraints, blocker, turn cap. Draft-first by default, or interactive clause by clause. |
| [architecture-audit](architecture-audit/) | 1.0.1 | Architecture audit that grants the existing code no authority: derive the requirements, design the minimal from-scratch architecture, then classify every component KEEP / SIMPLIFY / REPLACE / DELETE |
| [vellum](vellum/) | 0.18.2 | Plan at the frontiers and review the plan in the browser: decisions and interfaces before mechanics, vertical slices each closed by a check. /vellum:start opens a planning mode of its own: Claude writes the plan and its mockups and grills the reviewer on the open choices; the reviewer comments, edits or approves in a page, and the answer reaches Claude as a prompt. |
| [todos](todos/) | 1.4.1 | Shows the repository's TODOs in a scrolling band above the prompt, newest first: TODO.md items, TODO/FIXME/HACK code comments dated with git blame, and the findings agents record with todos-finding for a batch review; a Mine filter, issue links, picks put in the prompt for Claude, and a toast when one is added |
| [secret-pane](secret-pane/) | 0.3.1 | Claude asks for a secret in a masked box and gets a placeholder: the value stays in the session's memory, becomes real only inside a Bash command, is hidden again in every Bash and Read result and in the prompt, and never reaches the transcript; the mod writes nothing to disk |
| [agent-hooks](agent-hooks/) | 2.0.0 | Quality hooks for Claude Code and Codex that a repository opts into with one config file: fixers run on the text before each write, and Stop lanes check only the files the session changed, with a green cache and a loop guard that lets a stuck turn end; in every repository, a landing guard on Bash refuses the one-way doors of a push, a merge or a release; where the profile asks, Haiku refuses once an agent's commit message that tells how the change came about or how it was checked |
| [pinpoint](pinpoint/) | 0.5.2 | Point at your running app and talk to Claude: the session's address serves the app with an overlay that picks an element by a click or a zone by a drag, takes a quick label or a note, and keeps each selection in a batch you send at once; the batch reaches the session as a prompt, each element described by its selector, role, accessible name, box and styles, each zone with an image of it |
| [atlas](atlas/) | 0.1.1 | Interactive architecture maps in the browser: zones and bricks laid out by ELK, overview arrows routed by libavoid, typed data files checked by a script, and open points discussed in threads between you and the agent; /atlas:board serves a map's page beside your session and hands what you select there to the agent; /atlas:init draws a repository's first map, each claim citing its lines |
| [griller](griller/) | 0.1.0 | A grill where you answer before you see Claude's recommendation: Claude writes each round of questions in its reply, the chat hides every recommendation, and a pane beside it collects your answers and shows a recommendation only when you peek at it |

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
