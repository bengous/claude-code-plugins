# Git Tools Plugin

Interactive git commands with AI assistance for commit management and history rewriting.

## Overview

Git Tools provides AI-powered interactive git commands that enhance your workflow with intelligent suggestions, visual feedback, and safety guardrails.

## Features

- **Interactive Rebase**: Visual, multi-stage rebase workflow with AI-powered commit improvements
- **Repository Cleanup**: Automated cleanup of stale branches, worktrees, and closed PRs
- **Smart Commit Messages**: AI suggestions for reword operations following conventional commit patterns
- **Conflict Guidance**: Step-by-step resolution instructions when conflicts arise
- **Safety Checks**: Automatic backup branch creation and working directory validation
- **Visual Feedback**: ASCII graphs showing your rebase plan before execution

## Installation

This plugin is part of the bengolea-plugins marketplace. To install:

1. Add the marketplace to your Claude Code configuration
2. Install the git-tools plugin from the marketplace

## Commands

### `/analyze-git`

Analyze your git repository for cleanup opportunities. This is a READ-ONLY command that identifies:

- Local branches marked as `[gone]` (remote deleted)
- Prunable worktrees
- Dependabot PRs that are closed/merged but still have branches
- Overall branch inventory

**Usage:**
```bash
/git-tools:analyze-git
```

**Output:**
- Comprehensive report of cleanup opportunities
- Branch counts and specific names
- No modifications performed

**Follow-up:** Use `/git-tools:cleanup-git` after reviewing the analysis.

---

### `/cleanup-git`

Perform git repository cleanup based on `/analyze-git` findings.

**IMPORTANT:** This command performs DESTRUCTIVE operations. Always run `/git-tools:analyze-git` first.

**Usage:**
```bash
/git-tools:cleanup-git
```

**Operations:**
1. Remove worktrees and delete branches marked as `[gone]`
2. Prune stale worktrees
3. Clean up closed/merged dependabot branches
4. Provide cleanup summary

**Safety:**
- Preserves main/dev/master branches
- Preserves current branch
- Preserves active dependabot PRs (OPEN status)
- Cannot be easily undone - use with caution

---

### `/rebase`

Interactive git rebase with visual planning and AI-powered commit improvements.

**Usage:**
```bash
/rebase              # Rebase entire branch from merge-base
/rebase 5            # Rebase last 5 commits (HEAD~5)
/rebase abc123       # Rebase from specific commit/branch
/rebase abc123..def456  # Rebase specific range
```

**Workflow:**

1. **Select Range**: Choose what to rebase (entire branch, N commits, or custom range)
2. **Review Commits**: See all commits in the range with details
3. **Choose Actions**: For each commit, select:
   - `pick` (p): Keep commit as-is
   - `squash` (s): Combine with previous commit
   - `reword` (r): Edit commit message (AI suggestions provided)
   - `drop` (d): Remove commit
4. **Review Plan**: See visual graph of planned changes
5. **Execute**: Automatic backup branch created, rebase performed

**AI Features:**

- **Reword Suggestions**: When rewording, receive 3 AI-generated options:
  - Keep original
  - Improved clarity
  - Concise version
  - Or write custom message

- **Smart Squash Messages**: When squashing commits, AI analyzes all commit messages and generates an intelligent combined message following conventional commit patterns

**Safety:**

- Validates working directory is clean before starting
- Creates automatic backup branch (`backup-<branch>-<timestamp>`)
- Checks for unpushed commits
- Provides conflict resolution guidance if issues arise

**Example:**

```bash
/rebase 3

# Output:
# Rebase interactive mode - Last 3 commits
#
# Commit 1: a1b2c3d Add user authentication
# Action [p/s/r/d/?]: p
#
# Commit 2: d4e5f6g Fix login bug
# Action [p/s/r/d/?]: s
#
# Commit 3: g7h8i9j Update tests
# Action [p/s/r/d/?]: r
#
# Rebase Plan:
# ✓ PICK   a1b2c3d Add user authentication
# ⬆ SQUASH d4e5f6g Fix login bug
# ✎ REWORD g7h8i9j Update tests
#
# Proceed? (y/n)
```

## Requirements

- Git 2.0+
- jq (for JSON processing)
- Clean working directory for rebase operations

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
