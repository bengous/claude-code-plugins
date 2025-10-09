# Changelog

All notable changes to this marketplace and its plugins will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Marketplace
- Prepared repository for public distribution
- Added comprehensive README with installation instructions
- Fixed marketplace.json homepage URL
- Added .gitignore for runtime state files
- Added root LICENSE file

## [0.1.1] - 2025-10-09

### claude-orchestration

#### Fixed
- Corrected marketplace.json schema format
- Fixed shell script formatting with shfmt
- Resolved all shellcheck warnings (SC2250) by adding braces to variable references

#### Changed
- Improved shell script code quality and consistency

## [0.1.0] - 2025-10-09

### Marketplace
- Initial marketplace creation
- Added marketplace.json catalog

### claude-orchestration

#### Added
- Initial release of claude-orchestration plugin
- 32 slash commands across 4 categories:
  - 19 worktree management commands
  - 8 GitHub issue commands
  - 2 PR automation commands
  - 2 orchestration commands
- 3 safety hooks:
  - Worktree guard (prevents destructive git operations)
  - PR guard (enforces COMPLEX mode targeting)
  - Plan mode enforcer (ensures /orc:start planning)
- Multi-agent task orchestration system (/orc)
- SIMPLE/MEDIUM/COMPLEX workflow routing
- Worktree isolation for parallel development
- GitHub integration for issues and PRs

[Unreleased]: https://github.com/bengous/claude-code-plugins/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/bengous/claude-code-plugins/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bengous/claude-code-plugins/releases/tag/v0.1.0
