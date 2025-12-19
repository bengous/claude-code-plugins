---
description: Trigger Claude review on the PR for the current branch
allowed-tools:
  - Bash(git:*)
  - Bash(gh:*)
  - Read
  - Glob
  - Grep
---

# Trigger Claude Code Review

This command triggers a Claude review on the pull request associated with your current branch.

## Current Context

- Current branch: !`git branch --show-current`
- Upstream branch: !`git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "none"`

## Your Task

1. Get the current branch name using `git branch --show-current`

2. Determine the PR branch name:
   - Try `git rev-parse --abbrev-ref @{upstream} 2>/dev/null`
   - If upstream exists (format: `origin/branch-name`), extract the branch name part (after `/`)
   - If no upstream, use the current branch name

3. Search for open PRs:
   ```bash
   gh pr list --head "<branch-name>" --state open --json number,title
   ```

4. Handle the results:
   - **No PRs found:** Inform user no open PR exists for this branch
   - **Multiple PRs found:** List them with numbers and titles, ask which one
   - **Exactly one PR:** Proceed to step 5

5. Post the review trigger comment:
   ```bash
   gh pr comment <pr-number> --body "@claude review"
   ```

6. Get and display the PR URL:
   ```bash
   gh pr view <pr-number> --json url --jq '.url'
   ```

7. Confirm to user with PR number and URL

## Error Handling

If any `gh` command fails:
- Report the command that failed
- Show the error message
- Suggest checking `gh auth status` if it looks like an auth issue
