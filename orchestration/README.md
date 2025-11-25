# Claude Orchestration Plugin

Advanced orchestration system for managing development workflows with Claude Code.

## Features

Multi-agent task orchestration with a streamlined 4-phase workflow:

### Orchestration (`/orc`)

Comprehensive task delegation and coordination:

- `/orc <task>` - Orchestrate tasks with BASE/COMPLEX routing
- Inline codebase exploration (no explorer agents needed)
- Automatic task classification after understanding scope
- Architect agents with Opus 4.5 for complex features
- Parallel execution using git worktrees
- Built-in quality review
- Automated PR creation

## Installation

### Local Installation

1. Navigate to your project root
2. Ensure `.claude-plugin/` directory exists with `plugin.json`
3. The plugin will be automatically detected by Claude Code

### Usage

After installation, use the `/orc` command to orchestrate feature development:

```bash
# Orchestrate a feature with 4-phase workflow
/orc "Add user authentication"

# The orchestrator will:
# Phase 1: Understand - Explore codebase, classify as BASE/COMPLEX
# Phase 2: Plan - Design architecture, get approval
# Phase 3: Execute - Implement (single agent or parallel)
# Phase 4: Review - Quality review, create PR
```

## Workflow Overview

### Phase 1: Understand
- Inline exploration using Glob/Grep/Read
- Ask clarifying questions if needed
- Classify task as BASE or COMPLEX

### Phase 2: Plan
- Create base branch
- BASE: Design architecture inline
- COMPLEX: Spawn 2-3 Opus 4.5 architect agents, form consensus
- Single checkpoint: Approve before execution

### Phase 3: Execute
- BASE: Single implementation agent
- COMPLEX: Planning coordinator → Parallel agents → Merge coordinator

### Phase 4: Review
- Quality review with 1-2 reviewer agents
- Address high severity issues
- Create PR and summary

## Architecture

The plugin provides a structured orchestration workflow:

- **4-Phase Workflow**: Understand → Plan → Execute → Review
- **Inline Exploration**: Direct codebase exploration without agent overhead
- **Adaptive Agents**: Architects only for COMPLEX, Opus 4.5 for better designs
- **Git Worktree Isolation**: Separate worktrees for parallel development
- **Quality Review**: Automated code review before PR creation

## Requirements

- Claude Code CLI
- Git with worktree support
- `gh` CLI for GitHub operations

## License

MIT
