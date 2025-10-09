# Claude Code Plugins by Augustin BENGOLEA

Personal collection of Claude Code plugins for development workflow automation.

## Plugins

### claude-orchestration (v0.1.0)

Advanced orchestration system for managing development workflows with Claude Code.

**Features:**
- Worktree management (18+ commands)
- GitHub issue operations (8 commands)
- Multi-agent task orchestration (/orc)
- PR automation workflows

**Installation:**
```bash
# Add marketplace
/plugin marketplace add ~/projects/claude-plugins

# Install plugin
/plugin install claude-orchestration@bengolea-plugins
```

Or install directly:
```bash
/plugin install ~/projects/claude-plugins/orchestration
```

## Development

This monorepo contains all my Claude Code plugins. Each plugin lives in its own subdirectory with a standard plugin structure.

## License

MIT - See individual plugin LICENSE files for details.
