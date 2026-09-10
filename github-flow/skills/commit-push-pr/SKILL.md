---
name: commit-push-pr
description: Commit the current work, push the branch, then open or update its pull request.
argument-hint: "[issue-number] [image.png#alt ...] [what the reviewer should know]"
disable-model-invocation: true
---

# Commit, Push, PR

Two skills, in order. Neither one is reimplemented here.

1. **Commit.** Run `git:commit`, with the number from `$ARGUMENTS` when it holds one. Nothing to commit: say so and continue.
2. **PR.** Run `pr` with the rest of `$ARGUMENTS`. It owns the branch check, the push, the body and the images.

A failure in either step stops the chain and is reported verbatim.

Requires the `git` plugin for step 1.
