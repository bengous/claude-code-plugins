---
description: Install git worktree convention enforcement
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup":*)
  - Bash(ls:*)
  - Read(*:*)
---

# Git Worktree Setup

You are installing the git worktree convention enforcement system.

## What This Installs

1. **`git-wt` helper** - Creates worktrees at `../<repo>.wt/<name>/`
2. **`git-worktree-hook`** - Claude Code PreToolUse hook that blocks incorrect paths
3. **CLAUDE.md update** - Adds convention to global instructions
4. **Settings hook** - Registers the PreToolUse hook

## Your Task

### Step 1: Check Current State

Check what's already installed:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup" check
```

### Step 2: Run Installation

If not already installed, run:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup" install
```

### Step 3: Report Results

Tell the user what was installed and how to use it:

```
Installation complete!

Installed:
  ~/.local/bin/git-wt              # Worktree helper
  ~/.local/bin/git-worktree-hook   # Enforcement hook

Usage:
  git-wt fix-auth              # Creates worktree for branch 'fix-auth'
  git-wt review-pr-123 main    # Creates worktree on 'main' branch
  git wt feature/new-api       # Also works as git subcommand

Worktrees are created at: ../<repo>.wt/<name>/

The PreToolUse hook will block attempts to create worktrees elsewhere.
```

## Important

- The script handles all file operations
- Report any errors from the script to the user
- If already installed, inform the user (no action needed)
