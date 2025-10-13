---
description: Delete managed worktree (blocks if unmerged or locked unless --force)
argument-hint: <name> [--keep-branch] [--force]
allowed-tools:
  - Bash("/home/b3ngous/projects/claude-plugins/orchestration/scripts/worktree/worktree":delete)
model: claude-sonnet-4-5
---

Delete a managed worktree and optionally its git branch. Includes safety checks for unmerged changes and active locks to prevent accidental data loss.

**Safety checks:**
1. **Lock check**: Fails if worktree has active lock (not expired)
2. **Merge check**: Fails if branch not merged into base branch (e.g., `dev`)

Use `--force` to bypass both checks when necessary.

**Common patterns:**

```bash
# Safe delete after merging
/worktree:delete my-feature

# Delete but keep the git branch
/worktree:delete experiment --keep-branch

# Force delete unmerged work (dangerous!)
/worktree:delete abandoned-work --force

# Force delete locked worktree
/worktree:delete stuck-work --force
```

**Flags/Arguments:**

- `<name>` (required) - Worktree identifier to delete
- `--keep-branch` - Remove worktree but preserve git branch
- `--force` - Bypass lock and merge safety checks (dangerous!)

**What gets deleted:**

- Worktree directory and files
- Git branch (unless `--keep-branch`)
- Management metadata (JSON files)
- Lock file (if exists)

**Warning:**

Using `--force` can lead to data loss if the branch contains unmerged work. Always verify with `/worktree:status` before force-deleting.

**Related commands:**

- `/worktree:prune` - Bulk cleanup of merged worktrees
- `/worktree:unlock` - Release lock before deletion
- `/worktree:merge` - Merge worktree before deletion

!"/home/b3ngous/projects/claude-plugins/orchestration/scripts/worktree/worktree" delete $ARGUMENTS
