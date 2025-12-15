# git-worktree

Enforce consistent git worktree locations at `../<repo>.wt/` with stack support for multi-agent orchestration.

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

### Single Worktree

```bash
# Create worktree for a branch
git-wt fix-auth

# Create worktree with different directory name
git-wt review-pr-123 main

# Create new branch from base
git-wt -b dev my-feature feature/new-api

# Also works as git subcommand
git wt feature/new-api
```

Worktrees are created at `../<repo>.wt/<name>/`.

### Stack Operations (Multi-Agent Orchestration)

Stack operations create a root worktree plus children, designed for parallel multi-agent workflows where each agent works in isolation.

```bash
# Create a stack of worktrees
git-wt --stack '{"issue":42,"base":"dev","root":"gallery","children":["schema","api","ui"]}'

# Check stack status
git-wt --stack-status [stack-id]

# Remove stack (worktrees only by default)
git-wt --stack-cleanup <stack-id> [--delete-branches]
```

**JSON Input:**
```json
{
  "issue": 42,           // Optional: prefix for branches (falls back to YYYY-MM-DD)
  "base": "dev",         // Required: base branch for root
  "root": "gallery",     // Required: root worktree/branch name
  "children": ["schema", "api", "ui"]  // Optional: child worktrees
}
```

**JSON Output:**
```json
{
  "status": "created",
  "stack_id": "42-gallery",
  "metadata_path": "/path/to/repo.wt/.stack.json",
  "root": {
    "name": "gallery",
    "branch": "42-gallery",
    "path": "/absolute/path/repo.wt/gallery",
    "pr_target": "dev"
  },
  "children": [
    {
      "name": "schema",
      "branch": "42-gallery-schema",
      "path": "/absolute/path/repo.wt/schema",
      "pr_target": "42-gallery"
    }
  ]
}
```

**Branch Naming Convention:**
```
42-gallery              (root, PRs to dev)
42-gallery-schema       (child, PRs to 42-gallery)
42-gallery-api          (child, PRs to 42-gallery)
42-gallery-ui           (child, PRs to 42-gallery)
```

**Worktree Layout:**
```
repo.wt/
├── .stack.json         # Persisted metadata
├── gallery/            # Root worktree
├── schema/             # Child worktree
├── api/                # Child worktree
└── ui/                 # Child worktree
```

### Integration with Orchestration Plugins

```bash
# 1. Coordinator creates stack
result=$(git-wt --stack '{"issue":42,"base":"dev","root":"gallery","children":["schema","api","ui"]}')

# 2. Parse paths for sub-agents
schema_path=$(echo "$result" | jq -r '.children[] | select(.name=="schema") | .path')
api_path=$(echo "$result" | jq -r '.children[] | select(.name=="api") | .path')

# 3. Spawn sub-agents with cwd set to their worktree
spawn_agent --cwd "$schema_path" --task "Implement database schema"
spawn_agent --cwd "$api_path" --task "Implement API endpoints"

# 4. After sub-agents complete, each creates PR to root branch
# PR targets are in the output: children[].pr_target

# 5. Cleanup
git-wt --stack-cleanup 42-gallery --delete-branches
```

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

- `jq` (required for stack operations and hook JSON parsing)
- `~/.local/bin` in PATH

## License

MIT
