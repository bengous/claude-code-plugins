# Claude Orchestration Plugin

Parallel multi-agent orchestration for complex features with git worktree isolation.

## Features

Multi-agent task orchestration with a streamlined 3-phase workflow:

### Orchestration (`/orc`)

Comprehensive task delegation and coordination for **complex, parallelizable work**:

- `/orc <task>` - Orchestrate complex features with parallel execution
- 2-3 Opus architect agents for design consensus
- Parallel implementation using git worktrees
- Coordinated merge process with conflict resolution
- Built-in quality review
- Automated PR creation

> **Note**: For simple tasks (single-module, bug fixes), don't use /orc - just ask Opus directly.

## Installation

### Local Installation

1. Navigate to your project root
2. Ensure `.claude-plugin/` directory exists with `plugin.json`
3. The plugin will be automatically detected by Claude Code

### Usage

After installation, use the `/orc` command to orchestrate complex features:

```bash
# Orchestrate a complex feature with parallel execution
/orc "Add user authentication with OAuth, database migrations, and frontend UI"

# The orchestrator will:
# Phase 1: Understand & Plan - Explore, define chunks, architect consensus
# Phase 2: Execute - Parallel implementation in git worktrees
# Phase 3: Review & Ship - Quality review, create PR
```

## Workflow Overview

### Phase 1: Understand & Plan
- Inline exploration using Glob/Grep/Read
- Ask clarifying questions if needed
- Define 2-4 independent chunks
- Spawn 2-3 Opus architect agents, form consensus
- Create base branch
- Single checkpoint: Approve before execution

### Phase 2: Execute
- Planning coordinator creates git worktrees
- Parallel implementation agents (one per chunk)
- Merge coordinator merges sequentially, resolves conflicts

### Phase 3: Review & Ship
- Quality review with 1-2 reviewer agents
- Address high severity issues
- Create PR and summary

## When to Use /orc

- Multi-module features (backend + frontend + database)
- Large refactorings with independent pieces
- Cross-cutting changes across subsystems
- When you want multiple architect perspectives

## When NOT to Use /orc

- Single-file changes
- Bug fixes with clear scope
- Features contained in one module
- Anything a single agent can handle

## Architecture

- **3-Phase Workflow**: Understand & Plan → Execute → Review & Ship
- **Inline Exploration**: Direct codebase exploration without agent overhead
- **Multi-Architect Consensus**: 2-3 Opus agents design from different angles
- **Git Worktree Isolation**: Separate worktrees for parallel development
- **Quality Review**: Automated code review before PR creation

## Requirements

- Claude Code CLI
- Git with worktree support
- `gh` CLI for GitHub operations
- `jq` for JSON parsing
- **git-worktree plugin** (provides `git-wt` helper with stack support)

### Installing git-worktree Plugin

The orchestration plugin depends on the `git-worktree` plugin for managing worktree stacks. Install it first:

```bash
# If using the same marketplace
/plugin install git-worktree@bengolea-plugins

# Then run setup to install git-wt helper
/git-worktree:worktree-setup
```

This installs:
- `git-wt` helper with `--stack` support for creating worktree stacks
- Enforcement hook to ensure consistent worktree locations

### Why git-wt --stack?

The orchestration plugin uses `git-wt --stack` to create all worktrees in a single command:

```bash
# Single command creates root + all children
git-wt --stack '{"issue":42,"base":"dev","root":"auth","children":["db","api","ui"]}'
```

Benefits over manual `git worktree add`:
- **Single command**: Creates entire stack atomically
- **JSON output**: Exact paths and branch names for agents
- **Idempotent**: Retry-safe (returns existing info on collision)
- **PR targets**: Explicit merge relationships in output
- **Easy cleanup**: `git-wt --stack-cleanup` removes everything

## License

MIT
