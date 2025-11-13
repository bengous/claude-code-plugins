# Clean Up Git Repository

Perform git repository cleanup operations based on the analysis from `/git-tools:analyze-git`.

**IMPORTANT**: This command performs DESTRUCTIVE operations. Run `/git-tools:analyze-git` first to review what will be deleted.

## Prerequisites

You MUST run `/git-tools:analyze-git` before using this command to understand what will be deleted.

## Step 1: Clean Gone Branches with Worktrees

Run the following command to remove worktrees and delete branches marked as [gone]:

```bash
git branch -v | grep '\[gone\]' | sed 's/^[+* ]//' | awk '{print $1}' | while read branch; do
  echo "Processing branch: $branch"
  worktree=$(git worktree list | grep "\\[$branch\\]" | awk '{print $1}')
  if [ ! -z "$worktree" ] && [ "$worktree" != "$(git rev-parse --show-toplevel)" ]; then
    echo "  Removing worktree: $worktree"
    git worktree remove --force "$worktree"
  fi
  echo "  Deleting branch: $branch"
  git branch -D "$branch"
done
```

After completion, report:
- Number of worktrees removed
- Number of branches deleted
- Any errors encountered

## Step 2: Prune Stale Worktrees

Run the following command to prune worktrees marked as prunable:

```bash
git worktree prune -v
```

Report the output showing which worktrees were pruned.

## Step 3: Clean Closed Dependabot Branches

**IMPORTANT**: Before deleting, verify these are truly closed/merged by checking the PR list.

For each dependabot branch with a CLOSED or MERGED PR:

1. First, update remote references:
```bash
git fetch --prune
```

2. The fetch with --prune will automatically remove stale remote references

Report:
- Number of dependabot branches cleaned
- Any branches that still remain (likely have OPEN PRs)

## Step 4: Final Verification

After all cleanup operations:

1. List remaining local branches:
```bash
git branch
```

2. List remaining remote branches:
```bash
git branch -r
```

3. List remaining worktrees:
```bash
git worktree list
```

## Step 5: Provide Cleanup Summary

Create a summary report with:

1. **Branches Deleted**: Total count and names
2. **Worktrees Removed**: Total count and paths
3. **Remote Branches Cleaned**: Total count (dependabot)
4. **Final Inventory**: Current count of local branches, remote branches, and worktrees
5. **Space Saved**: Approximate disk space reclaimed (if measurable)

## Safety Notes

- This command performs DESTRUCTIVE operations
- Always run `/git-tools:analyze-git` first
- Operations cannot be easily undone (branches are deleted, not archived)
- Main branch (dev, master) and current branch are preserved by design
- Active dependabot branches (OPEN PRs) are preserved
