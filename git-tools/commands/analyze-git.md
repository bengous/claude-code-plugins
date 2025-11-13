# Analyze Git Repository for Cleanup

Perform a comprehensive analysis of the git repository to identify branches and worktrees that can be cleaned up. This is a READ-ONLY analysis - no deletions will be performed.

## Step 1: Analyze Local Branches with [gone] Status

Run the following command to identify branches whose remote tracking branches no longer exist:

```bash
git branch -v
```

Look for branches marked with `[gone]` status. These are local branches whose remote counterparts have been deleted.

## Step 2: Analyze Worktrees

Run the following command to list all worktrees:

```bash
git worktree list
```

Identify any worktrees marked as "prunable" - these can be safely removed.

## Step 3: Analyze Dependabot Branches

1. First, update remote references:
```bash
git fetch --prune
```

2. List all dependabot PRs and their status:
```bash
gh pr list --state all --limit 100 --json number,title,state,headRefName --jq '.[] | select(.headRefName | startswith("dependabot/")) | "PR #\(.number): \(.headRefName) - \(.state)"'
```

3. List current remote dependabot branches:
```bash
git branch -r | grep 'dependabot/'
```

Cross-reference to find dependabot branches with CLOSED or MERGED PRs that still have remote branches.

## Step 4: Analyze Other Stale Branches

List all local and remote branches to identify any other stale branches:

```bash
git branch
git branch -r
```

## Step 5: Provide Summary Report

Create a comprehensive summary report with:

1. **Gone Branches**: List of local branches marked [gone] with worktree indicators
2. **Prunable Worktrees**: List of worktrees that can be pruned
3. **Closed Dependabot PRs**: List of dependabot branches with closed/merged PRs
4. **Branch Inventory**: Total count of local and remote branches

**Format the report clearly with counts and specific branch names.**

End with: "Run `/git-tools:cleanup-git` to perform the cleanup operations."

## Important Notes

- This command performs NO modifications
- All operations are read-only
- Use this to review what needs cleanup before running `/git-tools:cleanup-git`
