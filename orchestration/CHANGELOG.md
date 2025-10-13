# Changelog

All notable changes to the Claude Orchestration Plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.6] - 2025-10-13

### Fixed
- **CRITICAL FIX**: Replaced non-standard `!"script" command` pattern with documented approach
- All 29 command files now follow official Claude Code slash command patterns
- Commands now provide clear instructions for Claude to execute scripts via Bash tool
- Removed undocumented auto-execution pattern that wasn't working correctly

### Changed
- Command files now end with "Your task:" section with execution instructions
- Scripts execute via allowed-tools Bash tool permissions (documented pattern)
- ${CLAUDE_PLUGIN_ROOT} now correctly resolved through allowed-tools frontmatter

### Technical Notes
**The Problem:**
- v0.2.5 used undocumented `!"${CLAUDE_PLUGIN_ROOT}/scripts/..." command $ARGUMENTS` pattern
- This pattern isn't documented in official Claude Code slash commands reference
- Official docs show inline bash execution with backticks: `` !`git status` ``
- The standalone `!` execution line at end of commands wasn't being processed correctly

**The Solution:**
- Commands now provide explicit instructions: "Execute the script to perform the X operation"
- allowed-tools frontmatter permits the Bash execution: `Bash("${CLAUDE_PLUGIN_ROOT}/scripts/...":command)`
- Claude receives clear instructions and executes via standard Bash tool
- ${CLAUDE_PLUGIN_ROOT} is expanded by Claude Code when loading allowed-tools
- This follows the documented pattern for plugin command bash execution

**Pattern Change:**
```markdown
Before (undocumented):
!"${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree" create $ARGUMENTS

After (documented):
**Your task:**
Execute the script to perform the create operation:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree" create $ARGUMENTS
```
The script is already permitted via allowed-tools. Run it and report the results.
```

## [0.2.5] - 2025-10-13 [DEPRECATED]

### Fixed
- **CRITICAL FIX**: Use absolute paths instead of ${CLAUDE_PLUGIN_ROOT}
- Plugin now works correctly with directory-source marketplaces
- All command files updated to use actual installation path

### Technical Notes - ${CLAUDE_PLUGIN_ROOT} Issue
Claude Code has a bug with directory-source marketplaces:
- Directory source: `/home/b3ngous/projects/claude-plugins`
- Plugin location: `/home/b3ngous/projects/claude-plugins/orchestration/`
- But ${CLAUDE_PLUGIN_ROOT} expands to: `~/.claude/plugins/marketplaces/bengolea-plugins/orchestration/` ❌

**Solution**: Use absolute paths matching actual install location.
This is required until Claude Code properly handles ${CLAUDE_PLUGIN_ROOT}
for directory-source marketplaces.

## [0.2.4] - 2025-10-13

### Changed
- Moved hooks from inline plugin.json to external hooks/hooks.json file
- Now follows Anthropic's official plugin pattern (security-guidance plugin)
- Hooks should auto-load from hooks/hooks.json per Claude Code plugin system

### Technical Notes
- Both inline and external hooks.json are supported by docs
- Anthropic's official plugins use external hooks/hooks.json
- Following official pattern for better compatibility

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
