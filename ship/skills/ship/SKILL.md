---
name: ship
description: >
  Ship a feature branch: prepare a clean PR (strip working files with
  intelligent suggestions), create/update the GitHub PR, then merge to main
  with GPG signing when ready. Detects lifecycle stage automatically.
  Use when: "ship", "prep pr", "create pr", "open pr", "merge to main",
  "submit for review", "push for review", "ship this branch".
disable-model-invocation: true
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/prep-pr.ts":*)
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/git-ship.ts":*)
  - Bash(test:*)
  - Bash(echo:*)
  - Bash(cat:*)
  - Bash(ls:*)
  - Bash(git branch:*)
  - Bash(git rev-parse:*)
  - Bash(git status:*)
  - Bash(git log:*)
  - Bash(git diff:*)
  - Bash(git checkout:*)
  - Bash(git commit:*)
  - Bash(git reset:*)
  - Bash(git clean:*)
  - Bash(git stash:*)
  - Bash(git push:*)
  - Bash(git worktree list:*)
  - Bash(git worktree remove:*)
  - Bash(git -C:*)
  - Bash(gh pr view:*)
  - Bash(gh pr create:*)
  - Bash(gh pr close:*)
  - Read
  - Write
  - Grep
  - Glob
---

# Ship

Route to the correct shipping phase based on repo state. The phase files
`setup.md`, `prep.md` and `merge.md` live in this skill's base directory.

## Inputs

- branch: !`git branch --show-current`
- repo: !`git rev-parse --show-toplevel 2>/dev/null || echo "none"`
- pr: !`gh pr view --json number,headRefName 2>/dev/null || echo "none"`
- config: !`cat .shiprc.json 2>/dev/null || echo "none"`
- tools: !`test -x "${CLAUDE_PLUGIN_ROOT}/scripts/prep-pr.ts" && test -x "${CLAUDE_PLUGIN_ROOT}/scripts/git-ship.ts" && echo "ok" || echo "missing"`

## Routing

```
if tools == "missing":
  STOP — tell user: prep-pr and/or git-ship not executable.
  Run: chmod +x "${CLAUDE_PLUGIN_ROOT}/scripts/prep-pr.ts" "${CLAUDE_PLUGIN_ROOT}/scripts/git-ship.ts"

if repo == "none":
  STOP — tell user: not inside a git repository.

if config == "none":
  Read setup.md and follow it
  (setup hands off to prep.md or merge.md itself — do not continue below)

if pr == "none":
  Read prep.md and follow it
else:
  Read merge.md and follow it
```

The merge phase detects and resumes an interrupted squash itself (staged
changes plus a `refs/ship-backup/<branch>` ref). Do not short-circuit here.
