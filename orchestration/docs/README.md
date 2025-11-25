# Claude Orchestration Plugin Documentation

> Parallel multi-agent orchestration for complex features with git worktree isolation

## Table of Contents

1. [Workflow Overview](workflow-overview.md) - Visual diagrams and phase details
2. [Testing Guide](testing-guide.md) - Layer testing with coverage analysis

## When to Use /orc

This plugin is designed for **complex, parallelizable work**. Use it when you need:

- **Multi-module features** - Backend + frontend + database changes
- **Large refactorings** - Cross-cutting changes across subsystems
- **Architect consensus** - Multiple Opus instances designing from different angles
- **Git worktree isolation** - Parallel agents working without conflicts

## When NOT to Use /orc

For simpler tasks, **don't use /orc** - just ask Opus directly:

- Single-file changes
- Bug fixes with clear scope
- Features contained in one module
- Anything a single agent can handle in one session
- Tasks that can't be split into 2+ independent chunks

The orchestration overhead isn't worth it for simple work.

## Quick Reference

### Usage

```bash
# Orchestrate a complex feature with parallel execution
/orc "Add user authentication with OAuth, database migrations, and frontend UI"

# The orchestrator handles:
# Phase 1: Understand & Plan - Explore, define chunks, architect consensus
# Phase 2: Execute - Parallel implementation in git worktrees
# Phase 3: Review & Ship - Quality review, PR creation
```

## Key Concepts

### 3-Phase Workflow (v2.1)

1. **Understand & Plan**: Inline exploration, define chunks, 2-3 Opus architects form consensus, single checkpoint
2. **Execute**: Planning coordinator creates worktrees, parallel implementation agents, merge coordinator
3. **Review & Ship**: 1-2 reviewers, PR creation

### Multi-Agent Coordination

- Spawn 2-3 Opus architect agents for design consensus
- Planning coordinator creates git worktrees per chunk
- Parallel implementation agents work in isolation
- Merge coordinator merges sequentially, resolves conflicts
- 1-2 reviewer agents validate quality

### Key Changes in v2.1

- Simplified from 4 phases to 3
- Removed BASE path (use Opus directly for simple tasks)
- Always spawns architect agents
- Always uses git worktrees
- Single checkpoint before execution

## Requirements

- **Claude Code CLI** - Latest version
- **Git** - Version 2.5+ (worktree support)
- **GitHub CLI** (`gh`) - For PR creation

## Example

```bash
/orc "Refactor authentication system with OAuth support"

# → Inline exploration
# → Define chunks: API layer, database migrations, frontend components
# → 2-3 Opus architects design approaches
# → Form consensus recommendation
# → Single checkpoint: Approve?
# → Planning coordinator creates worktrees
# → Parallel implementation agents (one per chunk)
# → Merge coordinator merges sequentially
# → Quality review
# → PR created
```

## Support

- **Issues**: [GitHub Issues](https://github.com/bengous/claude-code-plugins/issues)

## License

MIT

---

**Next Steps:**
- [Workflow Overview](workflow-overview.md) - Detailed phase diagrams
- [Testing Guide](testing-guide.md) - Layer testing with coverage
