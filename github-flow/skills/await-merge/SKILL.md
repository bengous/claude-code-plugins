---
name: await-merge
description: Wait for a PR's checks, merge it with linear history, update the local base branch.
argument-hint: "[pr-number|url]"
disable-model-invocation: true
allowed-tools: Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh pr merge:*), Bash(git switch:*), Bash(git pull:*)
---

# Await Merge

1. **Target.** `$ARGUMENTS`, else the PR of the current branch: `gh pr view <n> --json number,title,url,baseRefName,commits`. None found: stop and ask for the number.

2. **Strategy.** One question, with the commit subjects in it:
   - Squash: the commits become one. Default when they are not curated.
   - Rebase: the commits land as they are. Only when each one is atomic.

   Never a merge commit; the history stays linear.

3. **Watch.** `gh pr checks <n> --watch --fail-fast`. A failing check: report its name and stop. No retry, no merge. No checks reported: say so and continue.

4. **Merge.** `gh pr merge <n> --squash|--rebase --delete-branch`. An error: report it verbatim and stop.

5. **Local.** `git switch <baseRefName>` then `git pull --ff-only`.

6. **Report.** The PR URL, the strategy, the new tip of the base branch.
