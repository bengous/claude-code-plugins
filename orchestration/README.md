# Claude Orchestration Plugin

Advanced orchestration system for managing development workflows with Claude Code.

## Features

This plugin provides a streamlined command set for sophisticated development workflow management:

### Orchestration (`/orc`)

Multi-agent task delegation and coordination with 8-phase workflow:

- `/orc <task>` - Orchestrate tasks with BASE/COMPLEX routing
- Automatic task classification
- Parallel execution for complex features
- Built-in quality review and PR automation

### Worktree Management (`/orc:wt`)

Isolated development environments for the /orc workflow:

- `/orc:wt list` - List all managed worktrees
- `/orc:wt create <name>` - Create new isolated worktree
- `/orc:wt open <name>` - Get worktree path and branch (for delegation)
- `/orc:wt status <name>` - Show detailed git status
- `/orc:wt delete <name>` - Remove worktree
- `/orc:wt lock/unlock <name>` - Manage exclusive access locks
- `/orc:wt who <name>` - Show lock owner
- `/orc:wt prune` - Clean up old worktrees
- `/orc:wt doctor` - Health check all worktrees

## Installation

### Local Installation

1. Navigate to your project root
2. Ensure `.claude-plugin/` directory exists with `plugin.json`
3. The plugin will be automatically detected by Claude Code

### Usage

After installation, commands are available through the slash command interface:

```bash
# Orchestrate a feature with 8-phase workflow
/orc "Add user authentication"

# Manage worktrees directly
/orc:wt list
/orc:wt create my-feature --base dev --agent me --lock
/orc:wt status my-feature
/orc:wt delete my-feature
```

## Architecture

The plugin wraps existing shell script backends for maximum reliability:

- **Commands**: Markdown files with frontmatter defining behavior
- **Scripts**: Battle-tested shell scripts providing implementation
- **Security**: `allowed-tools` restrictions maintain security boundaries

## Requirements

- Claude Code CLI
- Git with worktree support
- `jq` for JSON processing

## License

MIT
