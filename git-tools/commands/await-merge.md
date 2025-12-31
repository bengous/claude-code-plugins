---
description: Wait for CI to pass, then merge PR and update local branch
argument-hint: "[pr-number]"
model: sonnet
allowed-tools:
  - Bash(gh:*)
  - Bash(git:*)
  - AskUserQuestion
---

Monitor CI checks on a PR. When all checks pass, merge the PR and update the local branch to include the merged changes.

## PR Detection

Use `$ARGUMENTS` if provided (PR number or URL). Otherwise, detect from current branch with `gh pr view`. If detection fails, stop and ask the user to provide the PR number.

## Workflow

### 1. Gather PR info

Run these commands to gather context:
```bash
gh pr view <pr> --json number,baseRefName,commits,title
gh pr checks <pr>
```

### 2. Ask merge strategy

Use **AskUserQuestion** to let the user choose:

**Question:** "How should this PR be merged?"
**Header:** "Merge"
**Options:**
1. **Squash** - Combine all commits into one
2. **Merge** - Keep individual commits

Include the commit count and titles in the question context so the user can make an informed decision.

### 3. Monitor CI

Poll `gh pr checks` until all checks complete. Report status changes as they occur.

**If checks fail:** Stop and report which checks failed. Do not attempt to merge.

### 4. Merge

When all checks pass, merge the PR using the strategy chosen in step 2.

Execute: `gh pr merge <pr> --delete-branch` with `--squash` or `--merge` accordingly.

**If merge fails:** Report the error (conflicts, branch protection, etc). Do not retry.

### 5. Update local

Checkout the base branch and pull:
```bash
git checkout <baseRefName>
git pull
```

### 6. Report outcome

Summarize: PR merged, strategy used, local branch updated.
