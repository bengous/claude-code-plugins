---
description: Install git-wt helper with stack support for multi-agent workflows
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup":*)
  - Bash(ls:*)
---

# Git Worktree Setup

You are installing the git worktree convention enforcement system.

## What This Installs

1. **`git-wt` helper** - Creates worktrees at `../<repo>.wt/<name>/` with stack support for multi-agent orchestration
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

When the check reports every component installed, say so and stop. Otherwise run:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup" install
```

The script does every file operation; edit none of the files it manages by hand.

### Step 3: Report Results

Relay what the install printed: each component and where it went, the usage lines, and any error verbatim. Add that the PreToolUse hook now blocks worktrees created outside `../<repo>.wt/<name>/`.
