# Claude Orchestration Plugin

Advanced orchestration system for managing development workflows with Claude Code.

## Features

Multi-agent task orchestration with an 8-phase workflow:

### Orchestration (`/orc`)

Comprehensive task delegation and coordination:

- `/orc <task>` - Orchestrate tasks with BASE/COMPLEX routing
- Automatic task classification (single vs. parallel agents)
- Parallel execution for complex features using git worktrees
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
# Orchestrate a feature with 8-phase workflow
/orc "Add user authentication"

# The orchestrator will:
# 1. Explore codebase
# 2. Ask clarifying questions
# 3. Design architecture
# 4. Classify as BASE or COMPLEX
# 5. Implement (single agent or parallel)
# 6. Review code quality
# 7. Create pull request
```

## Architecture

The plugin provides a structured orchestration workflow:

- **8-Phase Workflow**: From discovery to PR creation
- **Multi-Agent Coordination**: Parallel execution for complex features
- **Git Worktree Isolation**: Separate worktrees for parallel development
- **Quality Review**: Automated code review before PR creation

## Requirements

- Claude Code CLI
- Git with worktree support
- `gh` CLI for GitHub operations

## License

MIT
