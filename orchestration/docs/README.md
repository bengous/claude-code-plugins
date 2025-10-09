# Claude Orchestration Plugin Documentation

> Advanced orchestration system for managing development workflows with Claude Code

## Table of Contents

1. [Getting Started](getting-started.md) - Quick start guide and installation
2. [Architecture](architecture.md) - System design and core concepts
3. [Command Reference](#command-reference) - Complete command documentation
4. [Workflows](workflows.md) - Common patterns and best practices
5. [Safety Hooks](hooks.md) - Automatic workflow guards
6. [Troubleshooting](troubleshooting.md) - Common issues and solutions

## Command Reference

### Worktree Management
📁 [Worktree Commands](commands/worktree.md) - 19 commands for isolated development environments

- `/worktree` - List all managed worktrees
- `/worktree:create` - Create isolated worktree
- `/worktree:delete` - Remove worktree safely
- `/worktree:status` - Show detailed status
- `/worktree:lock/unlock` - Manage exclusive access
- [+ 14 more commands](commands/worktree.md)

### Issue Management
🐛 [Issue Commands](commands/issue.md) - 8 commands for GitHub issue operations

- `/issue` - List issues with filters
- `/issue:create` - Create new issue
- `/issue:view` - View issue details
- `/issue:comment` - Add comments
- `/issue:label` - Manage labels
- [+ 3 more commands](commands/issue.md)

### Orchestration
🎯 [Orchestration Commands](commands/orchestration.md) - Task delegation and coordination

- `/orc` - Main orchestration command
- `/orc:start` - Plan and execute with SIMPLE/MEDIUM/COMPLEX routing

### Pull Request Workflows
🔀 [PR Commands](commands/pr.md) - Pull request automation

- `/pr` - Create or surface PR (idempotent)
- `/pr:create` - Create PR with custom parameters

## Quick Reference

### Common Workflows

```bash
# Create issue and start orchestrated task
/issue:create issue-title="Add dark mode" priority=high
/orc:start "Implement dark mode toggle" --issue 123 --confirm

# Create isolated worktree for feature
/worktree:create my-feature --issue 123 --agent me --lock --install

# Check worktree status and locks
/worktree:status

# Create PR from current branch
/pr:create --base dev

# Clean up completed worktrees
/worktree:prune --force
```

### Orchestration Paths

| Path | Use Case | Execution |
|------|----------|-----------|
| **SIMPLE** | Trivial changes (<30 lines, single file) | Direct work on current branch |
| **MEDIUM** | Isolated features (single module) | Optional worktree isolation |
| **COMPLEX** | Multi-step, cross-cutting changes | Dedicated base branch + sub-PRs |

### Safety Features

The plugin includes three automatic safety hooks:

1. **worktree-guard** - Prevents raw git worktree commands
2. **pr-guard** - Enforces COMPLEX mode PR targeting rules
3. **planmode** - Ensures /orc:start uses planning phase

Learn more in [Safety Hooks Documentation](hooks.md).

## Key Concepts

### Worktrees
Git worktrees allow multiple working directories from the same repository. The plugin manages worktrees with:
- Metadata tracking (`.claude/worktrees/`)
- Lock management for exclusive access
- Agent delegation support
- Automatic cleanup and health checks

### Orchestration
Intelligent task routing based on complexity:
- Automatic classification (SIMPLE/MEDIUM/COMPLEX)
- State persistence (`.claude/run/`)
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
