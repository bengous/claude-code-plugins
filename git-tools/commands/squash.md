---
description: Squash git commits by pattern or hash without opening an editor
argument-hint: --pattern <regex> | --hashes <h1,h2,...> | --range <N> [--backup] [--dry-run]
allowed-tools:
  - Bash(git status:*)
  - Bash(git log:*)
  - Bash(git branch:*)
  - Bash(git reset:*)
  - Bash(git commit:*)
  - Bash(git rebase:*)
  - Bash(git rev-parse:*)
  - AskUserQuestion
---

# Git Squash (No Editor)

Squash git commits interactively without vim. Supports pattern matching, specific hashes, or simple ranges.

## Arguments

$ARGUMENTS

## Usage Examples

```bash
# Squash all commits matching a pattern (e.g., "shellcheck", "fix:", "WIP")
/squash --pattern "shellcheck"

# Squash specific commits by hash
/squash --hashes "abc123,def456,ghi789"

# Squash last N commits (simple case, all contiguous)
/squash --range 5

# Add --backup to create backup branch automatically
/squash --pattern "refactor" --backup

# Dry run to preview (no changes)
/squash --pattern "test" --dry-run
```

## How It Works

1. Analyze commits and identify targets to squash
2. Show preview of what will be squashed
3. Ask for confirmation using AskUserQuestion
4. (Optional) Create backup branch
5. Execute rebase using `GIT_SEQUENCE_EDITOR` (no vim!)

## Mode Details

**Pattern mode:**
- Pattern matching is **case-insensitive**
- First matching commit becomes the base (keep)
- All subsequent matching commits are squashed into it
- Non-matching commits in between are preserved

**Hashes mode:**
- First hash is the base (keep)
- Remaining hashes are squashed into first
- Order matters!

**Range mode:**
- Simple `git reset --soft HEAD~N` + new commit
- All N commits must be contiguous at HEAD
- Fast and safe for simple cases

## Requirements

- Clean working directory (no uncommitted changes)
- Must be on a branch (not detached HEAD)

## Implementation

Parse the arguments and execute the appropriate strategy:

**For --range N:**
```bash
# Create backup if requested
git branch backup-$(date +%s) HEAD

# Soft reset and recommit
git reset --soft HEAD~N
git commit -m "Squashed N commits"
```

**For --pattern or --hashes:**
```bash
# 1. List commits to find matches
git log --oneline HEAD~50..HEAD

# 2. Find the base commit (oldest matching)
# 3. Generate a sed script that changes "pick" to "squash" for target commits
# 4. Execute: GIT_SEQUENCE_EDITOR="sed -i '<script>'" git rebase -i <base>^
```

**Always:**
1. Verify clean working directory first: `git status --porcelain`
2. Show preview and get user confirmation before executing
3. Report success with the new commit hash
