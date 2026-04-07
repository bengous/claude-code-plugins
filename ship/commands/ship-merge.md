---
description: Merge PR branch to main via git-ship, close PR, cleanup. Called by /ship when PR exists.
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/git-ship":*)
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/prep-pr":*)
  - Bash(git checkout:*)
  - Bash(git push:*)
  - Bash(git branch -d:*)
  - Bash(git worktree remove:*)
  - Bash(git diff --cached:*)
  - Bash(git commit:*)
  - Bash(git reset:*)
  - Bash(git status:*)
  - Bash(git clean:*)
  - Bash(git stash:*)
  - Bash(git -C:*)
  - Bash(gh pr close:*)
---

# Ship Merge

Merge the PR branch into main locally with GPG signing, close the PR, and clean up.

## Context

- Branch: !`git branch --show-current`
- Repo root: !`git rev-parse --show-toplevel 2>/dev/null`
- PR info: !`gh pr view --json number,title,url,headRefName,reviewDecision,statusCheckRollup 2>/dev/null`
- git-ship location: !`test -x "${CLAUDE_PLUGIN_ROOT}/scripts/git-ship" && echo "${CLAUDE_PLUGIN_ROOT}/scripts/git-ship" || echo "missing"`
- Existing backups: !`git branch --list "backup/ship-*" 2>/dev/null`
- Worktree info: !`git worktree list 2>/dev/null`
- Remote branches: !`git branch -r --list "origin/*" 2>/dev/null`

## Pre-flight

If git-ship location is "missing", tell the user to run `chmod +x "${CLAUDE_PLUGIN_ROOT}/scripts/git-ship"` and stop.

## Identifying the PR branch

**Use `headRefName` from the PR info context above.** This is the authoritative branch name
from GitHub. Do NOT hardcode `{branch}-pr` -- the PR may have been created from the feature
branch directly, or with a custom name.

If the current branch is different from `headRefName`, checkout `headRefName` for the merge.

## Flow

### 1. Check for working files in PR branch

Run `prep-pr --dry-run` on the PR branch to detect working files using the project's
`.shiprc.json` config. Do NOT hardcode patterns -- the config is the source of truth.

```bash
git checkout {headRefName}
"${CLAUDE_PLUGIN_ROOT}/scripts/prep-pr" --dry-run
```

If the dry-run shows `status: "ok"` with files in `removed` (meaning files would be stripped):

1. Inform the user: "The PR branch still contains working files that should be stripped."
2. Use **AskUserQuestion**:
   - "Strip and force-push"
   - "Skip -- merge as-is"
   - "Abort"
3. If strip: run `"${CLAUDE_PLUGIN_ROOT}/scripts/prep-pr" --force --backup --pr-branch {headRefName}` then
   `git push --force-with-lease origin {headRefName}`
4. After force-push, sync the worktree to match remote:
   `git reset --hard origin/{headRefName}`
   Verify clean state: `git status --porcelain` must be empty.
   If not clean: `git checkout -- . && git clean -fd`

If dry-run shows `nothing-to-clean`, continue.

**Before continuing:** `git-ship` requires a clean working tree. If any prior step
(strip, force-push) left dirty state, resolve it now: commit, stash, or
`git checkout -- . && git clean -fd`.

### 2. Squash decision

Show the commit list. If only 1 commit, skip this step.

Otherwise, use **AskUserQuestion** with options:
- "Squash into 1 commit"
- "Keep full history"

### 3. Run git-ship

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/git-ship" [--squash|--no-squash]
```

Parse the JSON output.

### 4. Handle squash-staged

If the step is `squash-staged`:

1. Note the `backup_ref` from the output.
2. Show staged changes — run this in the **current directory** (the feature worktree),
   NOT in the main worktree: `git diff --cached --stat`
3. Read the `original_subjects` from the JSON output.
4. Write a **semantic commit message** -- focus on what was accomplished, not the
   incremental steps. Drop noise like "fix review", "remove unused import".
5. Commit: `git commit -m "<message>"`
6. Run: `"${CLAUDE_PLUGIN_ROOT}/scripts/git-ship" --continue`

### 5. On success (step is "merged")

Proceed through these steps **in order**, skipping any that don't apply:

**a. Push main?**
Use **AskUserQuestion**: "Yes, push main" / "No, not now"
If yes: `git push origin main`

**b. Close PR** (only if PR exists)
Must happen **before** deleting the remote branch (deleting auto-closes without comment).

Build the close comment:
- If squashed: `"Merged locally (squashed) at <sha>"`
- If 1 commit: `"Merged locally at <sha>"`
- If multiple: `"Merged locally: <first>..<last> (N commits)"`

Use **AskUserQuestion**: "Yes, close PR" / "No, leave it open"
If yes: `gh pr close <number> --comment "<comment>"`

**c. Cleanup** -- proceed immediately, confirm each action.
Use `headRefName` for the PR branch name, not assumptions:

- **Delete local PR branch**: `git branch -d {headRefName}` -- AskUser (skip if same as feature branch)
- **Delete local feature branch**: `git branch -d {feature-branch}` (only if NOT in worktree) -- AskUser
- **Delete remote branch**: `git push origin --delete {headRefName}` -- AskUser
- **Remove worktree**: `git worktree remove <path>` (only if in worktree) -- AskUser

### 6. Error handling

Handle based on the git-ship JSON output error field:

- **dirty-worktree**: Commit or stash first.
- **already-on-base**: Already on main, nothing to merge.
- **base-not-found**: Base branch doesn't exist. Suggest `git fetch origin main`.
- **rebase-conflict**: Conflicts found, rebase aborted. Guide user to resolve manually.
- **not-ff**: Merge wasn't fast-forward after retry. Investigate.
- **no-commit-after-squash**: User ran --continue without committing. Commit first.
- **dirty-main-worktree**: Main worktree has uncommitted changes. Show `dirty_files`.
  AskUser: "Stash main's changes and retry" / "I'll handle it myself".
  If stash: `git -C <main_path> stash push -m "git-ship: stashed before merge"`,
  re-run git-ship. After success, remind: `git -C <main_path> stash pop`.

## Rules

- Never push without asking.
- Never delete branches or worktrees without confirmation.
- Close PR **before** deleting the remote branch.
- Backup before any destructive operation.
- Always return to a valid branch on error.
- The commit message for squashed commits must be semantic and meaningful.
- Use `headRefName` from GitHub as the authoritative PR branch name.
