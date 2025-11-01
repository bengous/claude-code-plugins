# Claude Orchestration Plugin Documentation

> Advanced orchestration system for managing development workflows with Claude Code

## Table of Contents

1. [Getting Started](getting-started.md) - Quick start guide and installation
2. [Architecture](architecture.md) - System design and core concepts
3. [Command Reference](#command-reference) - Complete command documentation

## Command Reference

### Orchestration
🎯 [Orchestration Command](commands/orchestration.md) - Multi-agent task delegation and coordination

- `/orc <task>` - Main orchestration command with 8-phase workflow
  - Discovery: Understand requirements
  - Exploration: Analyze codebase
  - Clarification: Resolve ambiguities
  - Architecture: Design approach
  - Classification: BASE or COMPLEX routing
  - Implementation: Execute with agents
  - Quality Review: Code review
  - PR Creation: Automated pull request

## Quick Reference

### Usage

```bash
# Orchestrate a feature with full 8-phase workflow
/orc "Add user authentication"

# The orchestrator handles everything:
# - Codebase exploration
# - Clarifying questions
# - Architecture design
# - Parallel execution (if complex)
# - Quality review
# - PR creation
```

### Execution Paths

| Path | Use Case | Execution |
|------|----------|-----------|
| **BASE** | Single-agent implementation | One agent implements feature on base branch |
| **COMPLEX** | Multi-chunk parallel work | Multiple agents in isolated git worktrees, merged sequentially |

## Key Concepts

### 8-Phase Workflow
The `/orc` command follows a structured workflow:
1. **Discovery**: Understand what needs to be built
2. **Exploration**: Deep codebase analysis with explorer agents
3. **Clarification**: Ask user questions to resolve ambiguities
4. **Architecture**: Design multiple approaches, present options
5. **Classification**: Determine BASE vs COMPLEX execution
6. **Implementation**: Execute with single or multiple agents
7. **Quality Review**: Automated code review
8. **PR Creation**: Generate pull request with `gh` CLI

### Multi-Agent Coordination
For complex features, the orchestrator:
- Spawns planning coordinator to create git worktrees
- Delegates chunks to parallel implementation agents
- Merges work sequentially via merge coordinator
- Ensures isolation and conflict resolution
- Concurrency control via locks
- PR workflow automation

### State Management
The plugin maintains state in `.claude/run/`:
- `current.json` - Active orchestration state
- `{RUN_ID}.json` - Per-run historical records
- `locks/` - Branch locks for concurrency control

## Requirements

- **Claude Code CLI** - Latest version
- **Git** - Version 2.5+ (worktree support)
- **GitHub CLI** (`gh`) - For issue and PR commands

## Installation

See [Getting Started Guide](getting-started.md) for detailed installation instructions.

## Examples

### Example 1: Simple Bug Fix

```bash
# Quick fix without orchestration
git checkout -b fix/login-typo
# Make changes
/pr:create --base dev
```

### Example 2: Medium Feature

```bash
# Feature with isolation
/orc:start "Add user profile page" --confirm
# Classifies as MEDIUM
# Creates worktree if needed
# Implements feature
# Creates PR automatically
```

### Example 3: Complex Refactoring

```bash
# Multi-step architectural change
/orc:start "Refactor authentication system" --issue 42 --confirm
# Classifies as COMPLEX
# Creates feat/auth-refactor base branch
# Breaks down into steps:
#   - Step 1: Core module (PR to base)
#   - Step 2: OAuth integration (PR to base)
#   - Step 3: Tests + docs (PR to base)
# Final PR: base branch → dev
```

## Support

- **Issues**: [GitHub Issues](https://github.com/bengous/claude-code-plugins/issues)
- **Discussions**: [GitHub Discussions](https://github.com/bengous/claude-code-plugins/discussions)

## License

MIT - See [LICENSE](../LICENSE) for details.

---

**Next Steps:**
- [📖 Getting Started](getting-started.md) - Install and configure the plugin
- [🏗️ Architecture](architecture.md) - Understand the system design
- [📚 Workflows](workflows.md) - Learn common development patterns
