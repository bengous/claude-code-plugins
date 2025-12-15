---
description: Approve plan mode with worktree isolation and PR creation
---

Yes, enter plan mode.

This work will run in an isolated worktree so multiple issues can be handled in parallel. Include these steps in the plan:

1. Create a worktree using `git-wt <type>/<issue-number>-<slug>` where type is `fix`, `feat`, or `chore` based on the issue, and slug is 2-3 words from the title (e.g., `fix/292-playwright-caching`)
2. Change to the worktree directory before implementing any changes
3. After implementation, commit with a message that references the issue, then create a pull request using `gh pr create`
