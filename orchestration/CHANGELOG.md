# Changelog

All notable changes to the Claude Orchestration Plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2025-11-25

### Changed
- **BREAKING**: Removed BASE path - /orc is now exclusively for complex parallel work
- Simplified workflow from 4 phases to 3 phases:
  - Phase 1: Understand & Plan (merged previous phases 1-2)
  - Phase 2: Execute (parallel worktrees)
  - Phase 3: Review & Ship
- Always spawns 2-3 Opus architect agents (no inline design option)
- Always uses git worktrees (no base branch direct work)

### Removed
- BASE vs COMPLEX classification logic
- Single implementation agent path
- Inline architecture design option
- "Default to BASE if unsure" guidance

### Notes
For simple tasks (single-module, bug fixes, small features), use Opus directly without /orc.
The orchestration overhead is designed for complex, parallelizable work that benefits from:
- Git worktree isolation for parallel agents
- Multi-architect consensus on design
- Coordinated merge process

---

## [2.0.0] - 2025-11-25

### Changed
- **Major workflow redesign**: Reduced from 8 phases to 4 phases
  - Phase 1: Understand (combines Discovery + Exploration + Questions)
  - Phase 2: Plan (combines Architecture + Classification)
  - Phase 3: Execute (Implementation)
  - Phase 4: Review (Quality Review + PR)
- **Inline exploration**: Orchestrator explores directly using Glob/Grep/Read instead of spawning explorer agents
- **Classification after exploration**: Task complexity (BASE/COMPLEX) determined after understanding codebase
- **Architect agents for COMPLEX only**: Spawn 2-3 Opus 4.5 architects only for complex multi-module features
- **Form consensus**: Architect outputs synthesized into single recommendation (not all options shown)
- **Single checkpoint**: Reduced from 3 mandatory checkpoints to 1 (approve before execution)

### Added
- `agents/architect.md` - New architect agent template with Opus model for design work

### Removed
- `agents/coordinator.md` - Redundant with separate planning/merge coordinators
- Explorer agent spawning - Replaced with inline exploration
- Phases 2-5 from original workflow - Consolidated into new phases 1-2

### Breaking Changes
- Phase numbering changed completely (8 → 4)
- Explorer agents no longer spawned
- Architect agents only spawn for COMPLEX path
- Fewer user checkpoints during workflow

### Rationale
Opus 4.5 capabilities allow:
- Inline exploration without agent overhead
- Smarter autonomous decisions with fewer checkpoints
- Better consensus formation from multiple architect perspectives
- Reduced agent spawns for typical BASE tasks (~4-6 fewer)

---

## [1.1.0] - 2025-11-01

### Changed
- **Simplified architecture**: `/orc` command now uses native `git worktree add/remove/list` instead of custom wrappers
- Updated agent templates (planning-coordinator, merge-coordinator, coordinator) to use git commands directly
- Improved reliability by using standard git commands instead of custom implementations
- Updated plugin description and keywords to focus on core orchestration
- Removed 1,295 lines of backend script code for simpler maintenance

### Removed
- Utility commands: `/worktree:*`, `/orc:wt`, `/issue:*`, `/pr` (32 command files)
- Backend scripts: `scripts/worktree/worktree`, `scripts/issue/issue`
- Hooks system: `hooks/worktree-guard.py`, `hooks/hooks.json`
- Documentation: worktree, issue, PR, hooks, workflows guides

### Impact
- **Core `/orc` orchestration workflow unchanged** - same user-facing behavior
- Implementation now uses standard git/gh commands (more reliable, better LLM compatibility)
- Removed standalone utility commands - users should use `/orc` for orchestration or native git commands directly

### Rationale
Custom command wrappers added complexity and LLM inconsistency. Native git commands are:
- More reliable and consistent
- Better understood by LLMs
- Easier to maintain
- Standard across all environments

## [0.2.9] - 2025-10-13

### Changed
- **PORTABILITY FIX**: Removed hardcoded fallback path from all command files
- All 29 command files now use only marketplace path: `~/.claude/plugins/marketplaces/bengolea-plugins/orchestration`
- Plugin is now fully portable across all users and installations

### Technical Notes

**The Portability Problem:**
v0.2.8 had a fallback pattern:
```markdown
!`realpath ~/.claude/plugins/.../orchestration 2>/dev/null || echo "/home/b3ngous/projects/claude-plugins/orchestration"`
```

The fallback path was hardcoded to the developer's local machine, which would break for other users.

**The Solution:**
Removed the fallback entirely:
```markdown
!`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration`
```

This works because:
- Marketplace installations always place plugins at the standard location
- The `~` expands correctly on all Unix systems
- No fallback needed for published plugin

**Development Note:**
For local development with directory-source marketplace, developers can temporarily add their own fallback path to command files for testing.

## [0.2.8] - 2025-10-13

### Fixed
- **CRITICAL FIX**: Commands now execute correctly via inline path resolution
- Fixed repository detection to operate on current working directory instead of plugin location
- All 29 command files updated with working execution pattern
- Scripts now work correctly when plugin is used in external projects

### Changed
- Replaced `!"${CLAUDE_PLUGIN_ROOT}/script"` pattern with inline path resolution
- Commands now use `!`realpath ...`` to resolve plugin location at expansion time
- Updated `allowed-tools` to use `Bash(*:*)` for maximum flexibility
- Repository detection now uses `git rev-parse --show-toplevel` from current directory

### Technical Notes

**The Core Problem:**
- The `!"${CLAUDE_PLUGIN_ROOT}/script"` pattern doesn't auto-execute
- ${CLAUDE_PLUGIN_ROOT} is not available as shell variable at execution time
- Scripts were detecting the plugin's repository instead of the user's working repository

**The Solution:**
All command files now use this pattern:
```markdown
**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration 2>/dev/null || echo "/home/b3ngous/projects/claude-plugins/orchestration"`

**Your task:**

Execute the worktree management script:

\`\`\`bash
<plugin-location-from-above>/scripts/worktree/worktree create $ARGUMENTS
\`\`\`

Show the full output to the user.
```

This approach:
1. Uses inline backticks to resolve path at command expansion time
2. Falls back to directory source path if marketplace path doesn't exist
3. Claude sees the resolved path and executes the script manually
4. Scripts operate on current working directory's repository

**Repository Detection Fix:**
Changed from: `MAIN_REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"`
Changed to: `MAIN_REPO="$(git rev-parse --show-toplevel)"`

This ensures scripts operate on the user's repository, not the plugin's repository.

### Tested
- ✅ worktree list command
- ✅ worktree unlock command
- ✅ worktree delete command
- ✅ Cross-project usage verified

## [0.2.7] - 2025-10-13

### Fixed
- Reverted v0.2.5 hardcoded paths back to ${CLAUDE_PLUGIN_ROOT}
- All 30 command files now use ${CLAUDE_PLUGIN_ROOT} for portability
- hooks/hooks.json now uses ${CLAUDE_PLUGIN_ROOT}
- Plugin now works correctly across different installation methods and locations

### Technical Notes
**The Problem with v0.2.5:**
- Hardcoded paths like `/home/b3ngous/projects/claude-plugins/orchestration/...`
- Would only work on one specific machine/user
- Not portable across team members or different installations

**The Solution:**
- Use ${CLAUDE_PLUGIN_ROOT} environment variable (official Claude Code mechanism)
- Claude Code expands this variable to actual plugin installation location
- Works for all installation methods: directory-source, git-based, official marketplaces
- The `!"${CLAUDE_PLUGIN_ROOT}/script" command` pattern auto-executes scripts before command runs

**Important Pattern Documentation:**
The `!` prefix at end of command files is documented at:
https://docs.claude.com/en/docs/claude-code/slash-commands#bash-command-execution

```markdown
!"${CLAUDE_PLUGIN_ROOT}/scripts/worktree/worktree" list $ARGUMENTS
```

This pattern:
1. Auto-executes the script when slash command is invoked
2. Includes the script's output in Claude's context
3. Requires `allowed-tools` frontmatter to permit the Bash execution
4. ${CLAUDE_PLUGIN_ROOT} is expanded by Claude Code during plugin load

## [0.2.6] - 2025-10-13 [REVERTED]

### Reverted
- Incorrectly replaced `!"script"` pattern with manual instructions
- Misunderstood how bash auto-execution works in slash commands
- All changes reverted in favor of proper ${CLAUDE_PLUGIN_ROOT} fix

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
