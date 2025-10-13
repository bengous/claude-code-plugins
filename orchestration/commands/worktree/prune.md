---
description: Clean up merged or stale worktrees in bulk
argument-hint: [--merged] [--stale HOURS] [--force]
allowed-tools:
  - Bash("/home/b3ngous/projects/claude-plugins/orchestration/scripts/worktree/worktree":prune)
model: claude-sonnet-4-5
---

Bulk cleanup of managed worktrees based on merge status or staleness. Supports dry-run mode (default) to preview candidates before deletion.

**Common patterns:**

```bash
# Preview merged worktrees (dry-run)
/worktree:prune --merged

# Actually delete merged worktrees
/worktree:prune --merged --force

# Preview worktrees unchanged for 7 days
/worktree:prune --stale 168

# Aggressive cleanup: merged OR stale 7 days
/worktree:prune --merged --stale 168 --force

# Find abandoned worktrees (30 days)
/worktree:prune --stale 720
```

**Flags/Arguments:**

- `--merged` - Target worktrees where branch is merged into base (e.g., `origin/dev`)
- `--stale <hours>` - Target worktrees unchanged for N hours (uses `updated_at` timestamp)
- `--force` - Execute deletion (without this, only shows candidates)

**Behavior:**

- Without `--force`: Dry-run mode, lists candidates
- With `--force`: Deletes matching worktrees
- Multiple criteria are combined with OR logic (either condition matches)
- Respects lock safety (won't delete actively locked worktrees)

**Dry-run output:**

```
Candidate for pruning: my-feature (worktree/my-feature)
Candidate for pruning: api-work (worktree/123-api-work)
Use --force to delete candidates
```

**Force output:**

```
Deleted worktree my-feature
Deleted worktree api-work
Pruned 2 worktrees
```

**Safety notes:**

- Always run without `--force` first to preview
- Merged check uses `origin/<base>` comparison
- Stale check uses metadata timestamps, not git history
- Locked worktrees are NOT pruned automatically

**Related commands:**

- `/worktree:delete` - Delete single worktree
- `/worktree` - List all worktrees
- `/worktree:merge` - Merge before pruning

!"/home/b3ngous/projects/claude-plugins/orchestration/scripts/worktree/worktree" prune $ARGUMENTS
