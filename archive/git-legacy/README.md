# git-legacy (archived)

Early `git-tools` commands, retired because the mechanism each one existed to drive has been
replaced. Archived rather than deleted so the prompt text stays greppable.

## Contents

```
commands/
  analyze-git.md    # read-only branch/worktree cleanup report
  cleanup-git.md    # destructive counterpart to analyze-git
  plan-with-wt.md   # plan-mode approval phrase + worktree steps
```

## Why archived

**`analyze-git` and `cleanup-git`** are superseded by the `git-sweep` plugin (`/git-sweep`).
Everything they detected — `[gone]` local branches, prunable worktrees, stale branch
inventory — is a strict subset of what `git-sweep` audits, and `git-sweep` additionally
detects squash-merged branches, runs through reviewed scripts (`git-clean-audit`,
`git-clean-apply`), and applies changes atomically after confirmation.

Both files also predate the plugin frontmatter convention: neither had any frontmatter at
all, so neither carried a `description` or an `allowed-tools` list.

`cleanup-git` was the more pressing retirement. It handed the model a raw destructive shell
loop — `git worktree remove --force` and `git branch -D` over grepped branch names — with
correctness resting entirely on prose instructing the user to run `analyze-git` first. The
scripted audit-then-confirm-then-apply pipeline in `git-sweep` exists precisely to remove
that class of footgun.

**`plan-with-wt`** was invoked to approve plan mode by supplying the phrase "Yes, enter plan
mode." alongside worktree instructions. Plan mode is now entered via the `EnterPlanMode`
tool, and worktree isolation is available through `EnterWorktree` and the `git-worktree`
plugin, so the mechanism it existed to trigger is gone. It had no references anywhere in the
repo at archival time.

## Consumers updated at archival

- `git-tools/README.md` — the `/analyze-git` and `/cleanup-git` sections were removed and
  replaced with a pointer to `/git-sweep`.
- `.claude/rules/03-component-selection.md` — used `/analyze-git` as its worked example of a
  user-triggered command; now cites `/git-sweep`.
