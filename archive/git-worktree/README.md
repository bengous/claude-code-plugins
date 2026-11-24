# git-worktree (archived)

Retired plugin. It installed `git-wt`, a helper that created worktrees under `../<repo>.wt/`
(one at a time, or as a root-plus-children stack for multi-agent work), and a PreToolUse hook
that blocked `git worktree add` anywhere else. Archived rather than deleted so the scripts stay
readable.

## Why archived

Claude Code creates and manages worktrees itself, under `<repo>/.claude/worktrees/` rather than
the `../<repo>.wt/` convention this plugin enforced, and without the Bash `git worktree add` its
hook watched. The plugin predates that support and had no remaining user at archival time. Its
`post_worktree_setup` step (`bun install`, `mise trust`) ran only for the worktrees `git-wt`
created, never for the ones Claude Code creates.

## What replaces it

Claude Code's own worktrees ([docs](https://code.claude.com/docs/en/worktrees)):

- a session in its own worktree: `claude --worktree`, or the desktop app's per-session worktrees;
- a worktree entered mid-session: the `EnterWorktree` tool;
- parallel agents, each in its own worktree: `isolation: worktree` on a subagent, or a workflow;
- gitignored files carried into a new worktree: `.worktreeinclude` and the
  `worktree.symlinkDirectories` setting.

## Installed files

Archiving removes nothing from a machine where `/git-worktree:worktree-setup` ran. First remove
by hand the PreToolUse hook entry that runs `git-worktree-hook` from `~/.claude/settings.json`:
left pointing at a deleted binary, it errors on every Bash call. Then
`scripts/worktree-setup remove` deletes `~/.local/bin/git-wt` and
`~/.local/bin/git-worktree-hook`. The convention block in `~/.claude/CLAUDE.md` is removed by
hand.

## Consumers updated at archival

- `.claude-plugin/marketplace.json` and the root `README.md`: the `git-worktree` entry and row
  were removed.
- `git/README.md`: no longer names it as a sibling.
- `scripts/lib/plugin-sources.ts`: the comment on `worktreePathFor` that named `git-wt` was
  dropped.
- `claude-orchestration`: still published and still built on `git-wt --stack`; its install
  instructions copy this directory's standalone `scripts/git-wt` onto the `PATH` from a clone of
  the repository.

## Original documentation

### Problem

Git worktrees are powerful but lead to clutter when created ad-hoc:

```
~/projects/
├── my-project/                    # Main repo
├── my-project-auth-tests/         # Worktree? Project?
├── my-test-audit/                 # Who knows
└── random-feature-branch/         # Stale worktree
```

### Solution

This plugin enforces a simple convention:

```
~/projects/
├── my-project/                    # Main repo
└── my-project.wt/                 # All worktrees here
    ├── fix-auth/
    ├── review-pr-123/
    └── feature-xyz/
```

### Installation

```bash
/git-worktree:worktree-setup
```

This installs:
- `git-wt` helper script to `~/.local/bin/`
- `git-worktree-hook` enforcement hook
- Updates `~/.claude/CLAUDE.md` with convention
- Registers PreToolUse hook in settings

### Usage

#### Single Worktree

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

#### Stack Operations (Multi-Agent Orchestration)

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

#### Integration with Orchestration Plugins

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

### Enforcement

The PreToolUse hook blocks `git worktree add` commands that don't target the canonical location:

```
BLOCKED: Worktrees must be created in ../my-project.wt/

Use: git-wt <name> [branch]
Or:  git worktree add ../my-project.wt/<name> <branch>
```

### Commands

| Command | Description |
|---------|-------------|
| `/git-worktree:worktree-setup` | Install or check installation status |

### Requirements

- `jq` (required for stack operations and hook JSON parsing)
- `~/.local/bin` in PATH

## License

MIT
