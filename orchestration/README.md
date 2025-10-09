# Claude Orchestration Plugin

Advanced orchestration system for managing development workflows with Claude Code.

## Features

This plugin provides four integrated command groups for sophisticated development workflow management:

### Worktree Management (`/worktree`)

Isolated development environments with locking, delegation, and lifecycle management:

- `/worktree` - List all managed worktrees
- `/worktree:create` - Create new isolated worktree
- `/worktree:delete` - Remove worktree
- `/worktree:status` - Show detailed status
- `/worktree:lock/unlock` - Manage locks
- `/worktree:guide` - Workflow patterns and best practices

### Issue Management (`/issue`)

GitHub issue CRUD operations with filtering and label management:

- `/issue` - List issues with filters
- `/issue:create` - Create new issue
- `/issue:view` - View issue details
- `/issue:comment` - Add comments
- `/issue:label` - Manage labels
- `/issue:close/reopen` - Update issue state

### Orchestration (`/orc`)

Multi-agent task delegation and coordination:

- `/orc` - Orchestrate tasks with SIMPLE/MEDIUM/COMPLEX routing
- Automatic task classification
- Isolated worktree execution
- PR automation

### PR Workflows (`/pr`)

Pull request creation and management:

- `/pr` - Create or surface PR (idempotent)
- `/pr:create` - Create PR with custom parameters

## Installation

### Local Installation

1. Navigate to your project root
2. Ensure `.claude-plugin/` directory exists with `plugin.json`
3. The plugin will be automatically detected by Claude Code

### Usage

After installation, all commands become available through the slash command interface:

```bash
# List worktrees
/worktree

# Create isolated worktree
/worktree:create feat/new-feature

# List open issues
/issue

# Orchestrate a task
/orc "Add user authentication" --confirm
```

## Architecture

The plugin wraps existing shell script backends for maximum reliability:

- **Commands**: Markdown files with frontmatter defining behavior
- **Scripts**: Battle-tested shell scripts providing implementation
- **Security**: `allowed-tools` restrictions maintain security boundaries

## Requirements

- Claude Code CLI
- Git with worktree support
- GitHub CLI (`gh`) for issue and PR commands

## License

MIT
