---
description: Wait for CI to pass, then merge PR and update local branch
argument-hint: "[pr-number]"
model: sonnet
allowed-tools:
  - Bash(gh:*)
  - Bash(git:*)
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

### 2. Monitor CI

Poll `gh pr checks` until all checks complete. Report status changes as they occur.

**If checks fail:** Stop and report which checks failed. Do not attempt to merge.

### 3. Merge

When all checks pass, merge the PR:

**Merge strategy decision:**
- Use `--squash` if: single commit, or commit messages are low-quality (fixup, WIP, typo fixes)
- Use `--merge` if: multiple commits with clear, purposeful messages that tell a story

Execute: `gh pr merge <pr> --delete-branch` with the chosen strategy.

**If merge fails:** Report the error (conflicts, branch protection, etc). Do not retry.

### 4. Update local

Checkout the base branch and pull:
```bash
git checkout <baseRefName>
git pull
```

### 5. Report outcome

Summarize: PR merged, strategy used, local branch updated.
