---
name: commit-close
description: Commit the current work with a message that closes a GitHub issue.
argument-hint: "[issue-number]"
disable-model-invocation: true
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git add:*), Bash(git commit:*)
---

# Commit Close

1. **Issue.** `$ARGUMENTS`, else the leading number in the branch name (`fix/123-x` is 123). Neither: ask.
2. **Content.** Commit what is staged. Nothing staged: show `git status --short` and ask what to stage.
3. **Message.** Follow the convention visible in `git log --oneline -10`. Last line of the body: `Closes #<n>`.
4. **Caveat.** GitHub closes the issue when the commit reaches the default branch. On any other branch, say so once in the report.
