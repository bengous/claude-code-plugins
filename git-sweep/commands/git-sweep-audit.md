---
description: Audit branches/worktrees and collect cleanup choices. Called by /git-sweep.
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-audit":*)
  - Bash(printf:*)
  - Bash(git log:*)
  - Bash(git diff:*)
  - Bash(git symbolic-ref:*)
  - Read
  - Grep
  - Glob
---

# Git Sweep Audit

Scan, classify, collect user choices, build manifest, hand off to apply.

## Phase 1: Run audit

Tell the user what is about to happen: if the repo has an `origin`, the audit
fetches it read-only ("Fetching origin…") to refresh remote-tracking refs — it
does **not** prune or delete anything. With no origin it stays fully local: no
network, no ref deletion. Proving containment runs `git merge-tree`, which
leaves unreachable tree objects behind; no ref moves, and `git gc` collects them.

Execute the audit script, capturing exit code, stdout, and stderr. Do NOT
discard stderr — the failure reason must stay visible:

```
run `"${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-audit" --include-remote`
capture: exit_code, stdout, stderr

# The backend always emits JSON on failures it can catch. Empty or non-JSON
# stdout means it never started (bun missing, not executable, …) — a case the
# script itself cannot report. Guard before touching .ok:
if stdout is empty OR stdout is not valid JSON:
  STOP — report "audit backend failed" with exit_code and stderr

audit_json = parse stdout as JSON

# The default base is `main`. A repo whose trunk is named otherwise fails
# validation — resolve the real trunk and retry once before giving up.
#
# NEVER fall back to HEAD. It names the checked-out branch, not the trunk: from
# a feature branch it would make that branch the base, and the real trunk would
# then appear under "Merged" with "Delete all" as the recommended answer.
if audit_json.ok == false AND audit_json.error contains "base branch":
  trunk = `git symbolic-ref --short refs/remotes/origin/HEAD` with "origin/" stripped
          else the first of main, master, trunk whose BRANCH exists:
            `git rev-parse --verify refs/heads/{name}`
            (the bare name would also match a tag, which could be anywhere)
  if no trunk was found:
    STOP — tell user: no trunk branch found; re-run with `--base <branch>`
  re-run the audit with `--base {trunk}` and use that result

if audit_json.ok == false:
  STOP — report audit_json.error and audit_json.step

categories = audit_json.categories

# Branches held by a removable worktree are counted twice here (see 2a): this
# number gates "is there anything to do", it is not an operation count.
if every category is empty:
  STOP — tell user: repo is clean, nothing to do
```

## Phase 2: Report the findings, then ask once

Initialize the manifest. `base` and the per-branch `oid` are what let apply
re-check, at execution time, that it is deleting the commit the audit judged:

```
manifest = {
  base: audit_json.base,
  worktrees: [],
  branches: [],
  remote_branches: [],
  prune_remotes: false,
  prune_worktrees: false
}
```

**Force flag — one rule for every branch category:**

```
force = (branch.d_refusal != null)
```

`d_refusal` is the audit's prediction that `git branch -d` refuses, measured
against the branch's upstream (or HEAD when there is none). Never derive the
flag from the category. When it is set, show why next to the branch:
"force — not contained in {d_refusal}".

**Proof wording — never claim more than the audit proved:**

| `proof` | Say | Meaning |
|---------|-----|---------|
| `ancestry` | contained by ancestry | nothing is lost, history included |
| `no-merge-delta` | no merge delta | the content is on the base; the intermediate commits are not |
| `unproven` | unproven | the test did not conclude — this is **not** proof of absence |

### 2a. Show every non-empty category

Print one table per non-empty category, all of them, before asking anything.
Skip empty categories silently.

`Last commit` is `last_commit_date`; `Subject` is `last_commit_subject`.
Every branch table carries a `Deletion` column: "safe", or
"force — not contained in {d_refusal}".

```
removable_worktrees  | Worktree | Branch | Proof | Untracked files lost |
  Live worktree, no uncommitted changes, branch already contained in the base.
  Removing it is what frees the branch for deletion.
  Last column: `ignored.files` and `ignored.dirs` both named in full, with "…"
  when `ignored.truncated`. Say "none" when both are empty. These are files git
  never tracked — `git worktree remove` deletes them and nothing can bring them
  back. A per-worktree `.env` lives here. Name the directories rather than
  counting them: git collapses a whole ignored tree to one entry, so a
  disposable `node_modules/` and a `data/` holding a local database look
  identical until you read the name.

stale_worktrees      | Path | Branch | Reason |   (missing-dir, broken-ref)

merged_local         | Branch | Last commit | Subject | Deletion |

orphaned_worktree    | Branch | Ahead | Last commit | Subject | Proof | Deletion |
  `worktree-agent-*` branches with no worktree. Leftover from parallel agents,
  normally empty — an `unproven` one with `ahead` > 0 was worked on directly
  and holds the only copy of that work.

content_merged       | Branch | Ahead | Behind | Subject | Deletion |
  Say plainly: their content is on {base} (no merge delta), but their commits
  are not — squash, rebase or cherry-pick.

stale_remote         | Remote branch | Last commit | Subject | Proof |
  Remote refs carry no `d_refusal` and no force flag — deletion is by lease.
```

**The two worktree categories overlap the branch categories, on purpose.** A
branch whose worktree is removable appears twice: once as the worktree to free,
once in `merged_local` (or `content_merged`) as the branch to delete. Removing
the worktree is a precondition, not a separate outcome. Say so when you show
the tables, and honour the coupling in 2c — `git branch -d` fails with
"used by worktree" if the branch is deleted while its worktree stands.

For `backup` (`categories.backup`), analyze before listing — this is the one
category where a verdict is worth more than a row:

```
for each branch in backup:
  log       = run `git log --oneline {audit_json.base}..{branch.name} -5`
  diff_stat = run `git diff --shortstat {audit_json.base}...{branch.name}`

  Recommend DELETE when the work is visibly superseded on the base, or the
  name marks a temporary save (backup/ship-*, backup/pre-*) with no recent
  activity. Recommend KEEP when it carries files or work you cannot find on
  the base, or it was touched in the last days.

Show: | Branch | Ahead | Subject | Verdict + one-line reason |
```

Then show what was NOT touched, with the reason per line — a flat list of
names is what made the previous version unreadable:

```
kept (local)   | Branch | Reason |
  base | current | worktree:{detail} | dirty-worktree:{detail}
  | unproven:{detail} | too-old:{detail}

kept_remote    | Remote branch | Reason |   (only if non-empty)
  Display only — it is not carried into the hand-off.

if --include-remote was passed and audit_json.remote_base is null:
  Say: "No remote deletion proposed: origin/{base} was not found."
```

### 2b. Ask, grouped

Build one question per non-empty category, then send them **in a single
`AskUserQuestion` call** (the tool takes up to 4 questions). With more than 4
categories, send successive calls of 4. Do not ask one category at a time.
`stale_tracking` is never asked about — see 2c.

Each question, with its `header` (12 chars max) and its options:

| Category | header | Question | Options |
|----------|--------|----------|---------|
| `removable_worktrees` | Worktrees | Remove these N finished worktrees and delete the branches they hold? | Remove all (Recommended) / Select individually / Skip |
| `removable_worktrees`, K of N hold ignored files | Worktrees | Remove these N finished worktrees? K hold untracked files that removal destroys for good. | Remove only the safe ones (Recommended) / Remove all / Select individually / Skip |
| `removable_worktrees`, all N hold ignored files | Worktrees | Remove these N finished worktrees? All hold untracked files that removal destroys for good — listed above. | Select individually (Recommended) / Remove all / Skip |
| `stale_worktrees` | Stale wt | Clean up these N broken worktrees? | Clean up all (Recommended) / Select individually / Skip |
| `merged_local` | Merged | Delete these N branches already contained in {base}? | Delete all (Recommended) / Select individually / Skip |
| `orphaned_worktree` | Agent br | Delete these N leftover agent branches? | Delete all (Recommended) / Select individually / Skip |
| `content_merged` | Content | Delete these N branches whose content is on {base}? | Delete all (Recommended) / Select individually / Skip |
| `backup` | Backups | What should happen to these N backup branches? | Accept verdicts (Recommended) / Delete all / Select individually / Skip |
| `stale_remote` | Remote | Delete these N remote branches on origin? | Delete all (Recommended) / Select individually / Skip |

The question templates are written for N > 1; put them in the singular when a
category holds one item.

**No bulk recommendation ever covers a branch that is not proven contained, or
a worktree holding ignored files.** The audit already keeps unproven branches
out of every deletable category, so this bites in one place: a
`removable_worktrees` entry whose `ignored.files` is non-empty. Narrow the
recommended option to the entries with none; removing the rest stays available,
never suggested. When every entry holds ignored files the narrowed option would
do nothing, so recommend choosing one by one instead — never offer a
recommendation that is a no-op.

`backup` is the exception, and only because its recommendation is not bulk: the
verdict is reached per branch by reading its log and diff (2a). Unproven is the
normal state for a backup branch, so weigh `proof` and `ahead` as evidence
there rather than as a veto.

"Select individually" means: send one follow-up `AskUserQuestion`, batching the
items 4 at a time, each a yes/no on one item ("Delete {name}?" — "Delete" /
"Keep", `header` = a short form of the item name). Keep the items answered
"Delete"; the rest are dropped from that category.

### 2c. Map the answers onto the manifest

```
removable_worktrees / stale_worktrees:
  chosen paths → manifest.worktrees
  manifest.prune_worktrees = true if any chosen

merged_local / orphaned_worktree / content_merged / backup:
  chosen branches → manifest.branches += { name, force: (d_refusal != null), oid }

stale_remote:
  chosen → manifest.remote_branches += { remote: "origin", ref: name without "origin/", oid }
  manifest.prune_remotes = true if any chosen

stale_tracking (categories.stale_tracking):
  if non-empty: manifest.prune_remotes = true
  // Pruning tracking refs deletes no work, so it carries no question of its
  // own — this is the one exception to "one question per non-empty category".
```

Then enforce the worktree coupling, both ways:

```
for each branch in manifest.branches held by a worktree listed in
removable_worktrees OR stale_worktrees:
  if that worktree path is NOT in manifest.worktrees:
    drop the branch from manifest.branches

if any branch was dropped:
  Tell the user, naming them:
    from removable_worktrees — "Kept with their worktree: {names}. Deleting
      them needs the worktree removed first — `git branch -d` refuses while
      it stands."
    from stale_worktrees — "Kept: {names}. Their worktree directory is gone
      but its registration still holds the branch; `git worktree prune`
      releases it."
```

Say it in that turn: these branches are in neither the manifest nor `kept`
(which the audit computed before any answer), so nothing downstream will
mention them again.

Never add a branch to `manifest.branches` from the `removable_worktrees` rows —
those rows contribute the path only. The branch reaches the manifest through
its own category, which is where its `oid` and `d_refusal` live.

Carry `oid` through verbatim from the audit output. A manifest entry without
it is rejected by the backend, on purpose: without the audited commit there is
nothing to re-check at apply time.

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

Persist the manifest durably so the hand-off survives context compaction, then
invoke apply (which reads the saved file — no in-session state required):

```
# Write {manifest, kept} to the fixed repo-scoped path via the audit backend's
# save mode. It validates the shape and writes atomically (tmp + rename).
save = run `printf '%s' '{"manifest": {manifest_json}, "kept": {kept_json}}' \
  | "${CLAUDE_PLUGIN_ROOT}/scripts/git-clean-audit" --save-manifest`
parse save as JSON

if save.ok == false:
  STOP — report save.error (manifest was not persisted)
```

Then invoke `/git-sweep-apply`.
