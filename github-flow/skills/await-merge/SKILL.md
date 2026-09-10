---
name: await-merge
description: Wait for a PR's checks, merge it with linear history, update the local base branch.
argument-hint: "[--dry-run] [--rebase] [pr-number|url]"
disable-model-invocation: true
allowed-tools: Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh pr merge:*), Bash(git switch:*), Bash(git pull:*)
---

# Await Merge

1. **Target.** The number or URL in `$ARGUMENTS`, else the PR of the current branch: `gh pr view <n> --json number,title,url,baseRefName,commits`. None found: stop and ask for the number.

2. **Strategy.** Squash: the commits become one. `--rebase` in `$ARGUMENTS`: the commits land as they are, for a branch whose every commit is atomic. No question; the caller knows its commits. Never a merge commit; the history stays linear.

3. **Watch.** `gh pr checks <n> --watch --fail-fast`. A failing check: report its name and stop. No retry, no merge. No checks reported: say so and continue.

   `--dry-run`: print the target, the strategy, the commit subjects and the check state, then stop. The watch is the fact the merge depends on, so the preview includes it.

4. **Merge.** `gh pr merge <n> --squash|--rebase --delete-branch`. An error: report it verbatim and stop. A merge has no undo short of a revert, so the target is never guessed: step 1 takes the number from `$ARGUMENTS` or from the current branch, nothing else.

5. **Local.** `git switch <baseRefName>` then `git pull --ff-only`.

6. **Report.** The PR URL, the strategy, the new tip of the base branch.
