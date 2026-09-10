---
name: squash
description: Squash git commits by pattern, hash list, or the last N, without opening an editor. Use when the user asks to squash, fold, or combine commits, or to collapse fixup and WIP commits.
argument-hint: --pattern <regex> | --hashes <h1,h2,...> | --range <N> [--backup] [--dry-run]
allowed-tools:
  - Bash(git status:*)
  - Bash(git log:*)
  - Bash(git branch:*)
  - Bash(git reset:*)
  - Bash(git commit:*)
  - Bash(git -c sequence.editor=:*)
  - Bash(git rev-parse:*)
  - AskUserQuestion
  - Write
---

# Squash

Squash commits by pattern, hash list, or the last N. No editor opens: git's sequence editor runs a `sed` script and its commit editor copies a prepared message.

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
5. Execute the rebase

## Mode Details

**Pattern mode:**
- Pattern matching is **case-insensitive**
- First matching commit becomes the base (keep)
- All subsequent matching commits are squashed into it
- Non-matching commits in between are preserved

**Hashes mode:**
- First hash is the base (keep)
- Remaining hashes are squashed into first
- The order given is the order applied

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
# Create backup if requested; no command substitution in the name, it would
# force a permission prompt
git branch squash-backup-<branch> HEAD

# Soft reset and recommit
git reset --soft HEAD~N
git commit -m "<message composed from the N messages, shown in the preview>"
# The subject follows the convention of `git log --oneline -10`.
```

**For --pattern or --hashes:**
```bash
# 1. List the commits of the branch, no fixed depth. The base is origin/dev
#    when it exists, else the remote default branch (git rev-parse
#    --abbrev-ref origin/HEAD). On that branch itself, ask how far back to look.
git log --oneline <base>..HEAD

# 2. Find the base commit (oldest matching)
# 3. Write the combined message to a file outside the repo, then run this
#    command; change only the hash list, the last hash, the file path and
#    the base. Hashes are the short ones step 1 printed. The exec line sets the message: GIT_EDITOR is already set in
#    the session, so a core.editor override never reaches the squash.
git -c sequence.editor="sed -i -E -e '/^pick (<h2>|<h3>)/s/^pick/squash/' \
    -e '/^squash <h3>/a exec git commit --amend -F <msgfile>'" \
    -c core.editor=true rebase -i <base>^
```

**Always:**
1. Verify clean working directory first: `git status --porcelain`
2. Show preview and get user confirmation before executing
3. Report success with the new commit hash
