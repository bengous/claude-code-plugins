# Changelog

All notable changes to the Claude Orchestration Plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
