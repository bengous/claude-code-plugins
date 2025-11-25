# Claude Orchestration Plugin Documentation

> Advanced orchestration system for managing development workflows with Claude Code

## Table of Contents

1. [Workflow Overview](workflow-overview.md) - Visual diagrams and phase details
2. [Testing Guide](testing-guide.md) - Layer testing with coverage analysis

## Quick Reference

### Usage

```bash
# Orchestrate a feature with 4-phase workflow
/orc "Add user authentication"

# The orchestrator handles:
# Phase 1: Understand - Explore codebase, classify
# Phase 2: Plan - Architecture design, approval
# Phase 3: Execute - Implementation (single or parallel)
# Phase 4: Review - Quality review, PR creation
```

### Execution Paths

| Path | Use Case | Execution |
|------|----------|-----------|
| **BASE** | Single-agent implementation | One agent implements feature on base branch |
| **COMPLEX** | Multi-chunk parallel work | Opus architects + parallel agents in git worktrees |

## Key Concepts

### 4-Phase Workflow (v2.0)

1. **Understand**: Inline exploration, classify BASE/COMPLEX
2. **Plan**: Architecture design (inline or Opus architects), single checkpoint
3. **Execute**: Single agent or parallel worktree agents
4. **Review**: Quality review, PR creation

### Multi-Agent Coordination (COMPLEX path)

- Spawn 2-3 Opus architect agents for design consensus
- Planning coordinator creates git worktrees
- Parallel implementation agents work in isolation
- Merge coordinator merges sequentially
- 1-2 reviewer agents validate quality

### Key Changes in v2.0

- Reduced from 8 phases to 4
- Inline exploration (no explorer agents)
- Architect agents only for COMPLEX path
- Single checkpoint instead of 3
- Opus model for architect agents

## Requirements

- **Claude Code CLI** - Latest version
- **Git** - Version 2.5+ (worktree support)
- **GitHub CLI** (`gh`) - For PR creation

## Examples

### BASE Path (Simple Feature)

```bash
/orc "Add email validation to login form"

# → Inline exploration
# → Inline architecture design
# → Single checkpoint: Approve?
# → Single implementation agent
# → Quality review
# → PR created
```

### COMPLEX Path (Multi-Module Feature)

```bash
/orc "Refactor authentication system with OAuth support"

# → Inline exploration, classifies as COMPLEX
# → 2-3 Opus architects design approaches
# → Form consensus recommendation
# → Single checkpoint: Approve?
# → Planning coordinator creates worktrees
# → Parallel implementation agents
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
