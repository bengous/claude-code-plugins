---
description: Audit branches/worktrees and collect cleanup choices. Called by /git-sweep.
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-audit":*)
  - Bash(git log:*)
  - Bash(git diff:*)
  - Read
  - Grep
  - Glob
---

# Git Sweep Audit

Scan, classify, collect user choices, build manifest, hand off to apply.

## Phase 1: Run audit

Execute the audit script and parse its JSON output:

```
audit_json = run `"${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-audit" --include-remote 2>/dev/null`
parse audit_json as JSON

if audit_json.ok == false:
  STOP — report audit_json.error and audit_json.step

categories = audit_json.categories
total = sum of all category lengths

if total == 0:
  STOP — tell user: repo is clean, nothing to do
```

## Phase 2: Collect choices per category

Initialize empty manifest:
```
manifest = {
  worktrees: [],
  branches: [],
  remote_branches: [],
  prune_remotes: false,
  prune_worktrees: false
}
```

Process each non-empty category in order. Skip empty categories silently.

### 2a. Stale worktrees (`categories.stale_worktrees`)

```
if stale_worktrees is empty: skip

Show table:
  | Path                              | Branch              | Reason      |
  |-----------------------------------|---------------------|-------------|
  | /home/user/projects/etch.wt/feat1 | feature/old-work    | missing-dir |
  | /home/user/projects/etch.wt/fix2  | fix/stale-fix       | broken-ref  |

AskUserQuestion:
  "Clean up all (Recommended)" | "Select individually" | "Skip"

if "Clean up all":
  manifest.worktrees += all paths
  manifest.prune_worktrees = true
else if "Select individually":
  for each worktree: AskUserQuestion "Remove {path}?" → yes/no
  manifest.worktrees += selected paths
  manifest.prune_worktrees = true if any selected
else if "Skip":
  pass
```

### 2b. Merged local branches (`categories.merged_local`)

Safe to delete with `git branch -d` (no force needed) because git
confirms these are fully reachable from the base branch.

```
if merged_local is empty: skip

Show table:
  | Branch                          | Last commit          | Subject                    |
  |---------------------------------|----------------------|----------------------------|
  | feature/oxlint-skip-list        | 2026-03-31           | Update skip list coverage  |

AskUserQuestion:
  "Delete all (Recommended)" | "Select individually" | "Skip"

if "Delete all":
  manifest.branches += all as { name, force: false }
else if "Select individually":
  for each branch: AskUserQuestion "Delete {name}?" → yes/no
  manifest.branches += selected as { name, force: false }
else if "Skip":
  pass
```

### 2c. Orphaned worktree branches (`categories.orphaned_worktree`)

Branches matching `worktree-agent-*` with no active worktree.
Leftover from parallel agent work. Require `force: true` because
some may have diverged from base (unmerged agent work).

```
if orphaned_worktree is empty: skip

Show table:
  | Branch                    | Last commit | Subject          |
  |---------------------------|-------------|------------------|
  | worktree-agent-a1707e2c   | 2026-03-31  | Rewrite oxlint.. |
  | worktree-agent-a29b2738   | 2026-03-31  | Rewrite oxlint.. |

AskUserQuestion:
  "Delete all (Recommended)" | "Select individually" | "Skip"

if "Delete all":
  manifest.branches += all as { name, force: true }
else if "Select individually":
  for each branch: AskUserQuestion "Delete {name}?" → yes/no
  manifest.branches += selected as { name, force: true }
else if "Skip":
  pass
```

### 2d. Squash-merged branches (`categories.squash_merged`)

Require `force: true` because `git branch -d` rejects them: the
commit SHAs differ from what's on base, but the tree content is
identical (squash merge creates new commits with the same tree).

```
if squash_merged is empty: skip

Tell user: "These branches' work is on {base} via squash merge.
Git shows them as unmerged because commit SHAs differ, but the
tree content is identical."

Show table:
  | Branch                          | Ahead | Behind | Subject                         |
  |---------------------------------|-------|--------|---------------------------------|
  | feature/oxlint-batch1-modern-ts | 3     | 1      | Enable OXLint batch 1: modern.. |

AskUserQuestion:
  "Delete all (Recommended)" | "Select individually" | "Skip"

if "Delete all":
  manifest.branches += all as { name, force: true }
else if "Select individually":
  for each branch: AskUserQuestion "Delete {name}?" → yes/no
  manifest.branches += selected as { name, force: true }
else if "Skip":
  pass
```

### 2e. Backup branches (`categories.backup`)

This is where intelligence matters. Do not just list -- analyze each branch.

```
if backup is empty: skip

for each branch in backup:
  log = run `git log --oneline {audit_json.base}..{branch.name} -5`
  diff_stat = run `git diff --stat {audit_json.base}...{branch.name} | tail -1`

  Apply these criteria to recommend DELETE or KEEP:

  RECOMMEND_DELETE when:
    - All files modified by the branch also exist (same or evolved) on base
    - Commit subjects reference features/fixes already visible on base
    - Branch has no activity in >30 days
    - Branch name suggests it was a temporary save (backup/ship-*, backup/pre-*)

  RECOMMEND_KEEP when:
    - Branch contains files not present on base
    - Commit subjects reference work not visible on base history
    - Branch has recent activity (<7 days)

  Mark as RECOMMEND_DELETE or RECOMMEND_KEEP with a one-line reason

Show table:
  | Branch                         | Ahead | Subject                     | Verdict |
  |--------------------------------|-------|-----------------------------|---------|
  | backup/fork-escape-hatches     | 73    | Replace scoring layer req.. | DELETE -- work superseded by vertical-slices restructuring |
  | backup/ship-1775040487         | 15    | Add .shiprc.json, remove..  | DELETE -- ship config already on main |

AskUserQuestion:
  "Accept suggestions" | "Delete all" | "Select individually" | "Skip"

if "Accept suggestions":
  manifest.branches += RECOMMEND_DELETE items as { name, force: true }
else if "Delete all":
  manifest.branches += all as { name, force: true }
else if "Select individually":
  for each branch: AskUserQuestion "Delete {name}?" → yes/no
  manifest.branches += selected as { name, force: true }
else if "Skip":
  pass
```

### 2f. Stale remote branches (`categories.stale_remote`)

```
if stale_remote is empty: skip

Show table:
  | Remote branch                              | Last commit | Subject                    |
  |--------------------------------------------|-------------|----------------------------|
  | origin/feature/oxlint-batch1-modern-ts     | 2026-03-31  | Enable OXLint batch 1..    |
  | origin/dev                                 | 2026-03-15  | Merge feature/simplified.. |

AskUserQuestion:
  "Delete all (Recommended)" | "Select individually" | "Skip"

if "Delete all":
  for each remote_branch:
    ref = strip "origin/" prefix from name
    manifest.remote_branches += { remote: "origin", ref }
  manifest.prune_remotes = true
else if "Select individually":
  for each remote_branch: AskUserQuestion "Delete {name}?" → yes/no
  manifest.remote_branches += selected (strip prefix)
  manifest.prune_remotes = true if any selected
else if "Skip":
  pass
```

### 2g. Stale tracking refs (`categories.stale_tracking`)

```
if stale_tracking is not empty:
  manifest.prune_remotes = true
  // Pruning tracking refs is always safe -- no question needed
```

## Phase 3: Check manifest

```
total_ops = len(manifest.worktrees)
           + len(manifest.branches)
           + len(manifest.remote_branches)
           + (1 if manifest.prune_remotes)
           + (1 if manifest.prune_worktrees)

if total_ops == 0:
  STOP — tell user: no operations selected, nothing to do

kept = audit_json.kept
```

## Phase 4: Hand off

Invoke `/git-sweep-apply` with the manifest JSON and the kept list.
