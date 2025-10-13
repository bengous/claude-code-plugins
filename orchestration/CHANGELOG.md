# Changelog

All notable changes to the Claude Orchestration Plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2025-10-13

### Fixed
- Reverted to `${CLAUDE_PLUGIN_ROOT}` variable for proper path resolution
- Fixed plugin compatibility with directory-source marketplaces
- Plugin now works correctly when installed from local directory source

### Technical Notes
- Hardcoded paths (~/.claude/plugins/...) don't work for directory-source marketplaces
- ${CLAUDE_PLUGIN_ROOT} is the official Claude Code mechanism for portable plugin paths
- Plugin now correctly resolves paths regardless of installation method (directory, git, etc.)

## [0.2.2] - 2025-10-13 [DEPRECATED]

### Fixed
- Attempted fix using hardcoded paths (reverted in 0.2.3)
- Removed outdated `orchestration/hooks/hooks.json` that referenced deleted hook scripts

## [0.2.1] - 2025-10-12

### Fixed
- Workflow diagram alignment and formatting
- Removed emojis from workflow documentation for better display

### Changed
- Updated documentation to reflect simplified workflow

## [0.2.0] - 2025-10-12

### Changed
- Major refactoring to reduce friction in orchestration workflows
- Simplified approval system with tiered levels
- Flattened agent spawning architecture
- Removed hierarchical complexity
- Enhanced workflow enforcement with TodoWrite integration

### Added
- Comprehensive workflow overview with visual diagram
- New agent delegation patterns
- Planning coordinator and merge coordinator agents

### Removed
- Complex nested approval workflows
- Hierarchical agent spawning patterns
- Old orchestration path implementations

## [0.1.1] - 2025-10-09

### Added
- Hooks for workflow safety and policy enforcement
- worktree-guard.py: Blocks raw git worktree commands
- pr-guard.sh: Enforces COMPLEX orchestration PR policy
- planmode.sh: Enforces plan mode for /orc commands

### Changed
- Hooks now auto-register on plugin installation
- No manual .claude/settings.json configuration needed

## [0.1.0] - 2025-10-09

### Added
- Initial plugin release
- Worktree management commands (18+ subcommands)
- Issue management commands (8 subcommands)
- Orchestration system (/orc) with SIMPLE/MEDIUM/COMPLEX routing
- PR workflow commands
- Complete migration from slash commands to plugin format
- Shell script backends preserved for stability
- Security boundaries via allowed-tools restrictions
