# git-worktree

Enforce consistent git worktree locations at `../<repo>.wt/`.

## Problem

Git worktrees are powerful but lead to clutter when created ad-hoc:

```
~/projects/
├── my-project/                    # Main repo
├── my-project-auth-tests/         # Worktree? Project?
├── my-test-audit/                 # Who knows
└── random-feature-branch/         # Stale worktree
```

## Solution

This plugin enforces a simple convention:

```
~/projects/
├── my-project/                    # Main repo
└── my-project.wt/                 # All worktrees here
    ├── fix-auth/
    ├── review-pr-123/
    └── feature-xyz/
```

## Installation

```bash
/git-worktree:worktree-setup
```

This installs:
- `git-wt` helper script to `~/.local/bin/`
- `git-worktree-hook` enforcement hook
- Updates `~/.claude/CLAUDE.md` with convention
- Registers PreToolUse hook in settings

## Usage

```bash
# Create worktree for a branch
git-wt fix-auth

# Create worktree with different directory name
git-wt review-pr-123 main

# Also works as git subcommand
git wt feature/new-api
```

Worktrees are created at `../<repo>.wt/<name>/`.

## Enforcement

The PreToolUse hook blocks `git worktree add` commands that don't target the canonical location:

```
BLOCKED: Worktrees must be created in ../my-project.wt/

Use: git-wt <name> [branch]
Or:  git worktree add ../my-project.wt/<name> <branch>
```

## Commands

| Command | Description |
|---------|-------------|
| `/git-worktree:worktree-setup` | Install or check installation status |

## Requirements

- `jq` (for hook JSON parsing)
- `~/.local/bin` in PATH

## License

MIT
