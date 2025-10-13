---
description: Merge worktree branch into target branch (default: dev)
argument-hint: <name> [--to dev] [--no-ff]
allowed-tools:
  - Bash(*:*)
model: claude-sonnet-4-5
---

Merge worktree branch into target branch with automatic rebase support and fast-forward preference. Handles the complete workflow: checkout target, pull latest, merge, return to worktree branch.

**Merge strategy:**
1. Attempts fast-forward merge (`--ff-only`)
2. If fast-forward fails, rebases worktree branch onto target
3. Then retries fast-forward merge
4. Falls back to regular merge with `--no-ff` if requested

**Common patterns:**

```bash
# Merge into default target (dev)
/worktree:merge my-feature

# Merge into staging
/worktree:merge hotfix --to staging

# Force merge commit (no fast-forward)
/worktree:merge my-feature --no-ff

# Complete workflow
/worktree:status my-feature     # Verify clean state
/worktree:merge my-feature      # Merge to dev
/worktree:delete my-feature     # Clean up
```

**Flags/Arguments:**

- `<name>` (required) - Worktree identifier
- `--to <branch>` - Target branch (default: `dev`)
- `--no-ff` - Force merge commit (disable fast-forward)

**Behavior:**

1. Validates repository has clean working directory
2. Fetches latest from origin for target branch
3. Checks out target branch in main repo
4. Pulls latest changes for target
5. Attempts merge (fast-forward preferred)
6. If fast-forward fails and no `--no-ff`: rebases worktree branch
7. Returns to worktree branch after merge

**Requirements:**

- Main repository must have clean working directory
- Worktree branch must exist
- Target branch must exist

**After merging:**

Use `/worktree:delete <name>` to clean up the worktree and branch.

**Related commands:**

- `/worktree:status` - Check state before merge
- `/worktree:delete` - Clean up after merge
- `/worktree:prune` - Bulk cleanup of merged worktrees

**Plugin location:** !`realpath ~/.claude/plugins/marketplaces/bengolea-plugins/orchestration`

**Your task:**

Execute the worktree management script:

```bash
<plugin-location-from-above>/scripts/worktree/worktree merge $ARGUMENTS
```

Show the full output to the user.