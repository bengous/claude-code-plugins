---
description: Create a commit that closes a GitHub issue
argument-hint: "[issue-number]"
allowed-tools:
  - Bash(git:*)
---

Create a git commit following standard commit guidelines, then append `Closes #N` to close the issue.

**Issue detection:** Use `$ARGUMENTS` if provided, otherwise extract from branch name (e.g., `fix/123-*` → `123`).

Now commit with: $ARGUMENTS
