---
name: commit
description: Commit the current work with a message that follows the repo's convention, closing the branch's issue when its name carries a number. Use when the user asks to commit, to record the work, or to save a change to history.
argument-hint: "[issue-number] [--no-close]"
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git add:*), Bash(git commit:*)
---

# Commit

## Context

- Status: !`git status --short`
- Diff, staged and unstaged: !`git diff HEAD`
- Branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Task

1. **Scope.** Something staged: commit that, leave the rest alone. Nothing staged: stage what forms one commit from the diff above, leave the rest. The diff omits untracked files; they appear as `??` in the status, and a new file that the diff's changes import belongs to the same commit. A file that carries a secret is never staged, whatever the diff shows: `.env` and its variants, a private key, a credentials or token file. Name it and stop.
2. **Issue.** A number in `$ARGUMENTS`, else the leading number of the branch name (`fix/123-popover` is 123). `--no-close`, or no number in either place: no trailer, and no question. Otherwise the last line of the body is `Closes #<n>`.
3. **Message.** Follow the convention visible in the recent commits above. Subject in the imperative, no trailing period. The body says why, never what the diff shows.
4. **One batch.** Stage and commit in a single tool batch, with nothing in between.
5. **Report.** The happy path says nothing beyond the commit. One line, when it applies: a file left unstaged on purpose, or a `Closes` trailer on a branch that is not the default, since GitHub closes the issue only when the commit reaches that default branch.
