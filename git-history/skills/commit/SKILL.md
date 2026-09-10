---
name: commit
description: Commit the staged work with a message that follows the repo's convention.
argument-hint: "[subject hint]"
disable-model-invocation: true
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*)
---

# Commit

1. **Content.** Commit what is staged. Nothing staged: show `git status --short` and ask what to stage.
2. **Message.** Follow the convention visible in `git log --oneline -10`. `$ARGUMENTS`, when given, is the subject or its scope; keep it.
3. **One batch.** Stage and commit in a single tool batch. No other tool, no other text.
