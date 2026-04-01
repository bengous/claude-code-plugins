---
description: Strip working files and create a GitHub PR. Called by /ship when no PR exists.
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/prep-pr":*)
  - Bash(git push -u origin:*)
  - Bash(git checkout:*)
  - Bash(gh pr create:*)
---

# Ship Prep

Prepare a clean PR branch by stripping working files and creating a GitHub PR.

## Context

- Branch: !`git branch --show-current`
- Repo root: !`git rev-parse --show-toplevel 2>/dev/null`
- Working tree: !`git status --short`
- Commits vs main: !`git log --oneline main..HEAD 2>/dev/null`
- Diff stats: !`git diff --stat main...HEAD 2>/dev/null`
- Local branches: !`git branch --list 2>/dev/null`
- Config: !`cat .shiprc.json 2>/dev/null`

## Phase 0: Dry-run

Run the prep-pr script in dry-run mode to detect working files:

```
dry_run = run `"${CLAUDE_PLUGIN_ROOT}/scripts/prep-pr" --dry-run`
parse dry_run as JSON
```

## Pre-flight

If the working tree is not clean, tell the user to commit or stash first and stop.
If the branch is detached, tell the user to checkout a branch and stop.

## Flow

### 1. Parse the dry-run output

The dry-run JSON (from Phase 0) shows which files would be stripped. If `status` is
`nothing-to-clean`, skip to step 4 (create PR directly from the current branch, no -pr
branch needed).

### 2. Intelligent artifact analysis

Read each file that would be stripped. For each one, assess whether it would be
useful for a PR reviewer (e.g., an ADR or architecture decision) or is just working
noise (e.g., brainstorm notes, scratch files, personal plans).

Present your analysis:

> **Strip (working noise):**
> - `plans/2026-04-01/notes.md` -- brainstorm notes, not useful for review
>
> **Keep (useful for review):**
> - `plans/2026-04-01/adr-001.md` -- architecture decision, gives context

Use **AskUserQuestion** with options:
- "Accept Claude's suggestions"
- "Strip all working files"
- "Keep everything in the PR"
- "Let me choose"

If "Let me choose": present the file list and let the user select which to strip.

### 3. Execute the strip

Based on the user's choice, run the prep-pr script:

- **Strip all**: `"${CLAUDE_PLUGIN_ROOT}/scripts/prep-pr" --force --backup`
- **Strip selected**: `"${CLAUDE_PLUGIN_ROOT}/scripts/prep-pr" --force --backup -- file1.md file2.md`
- **Keep all**: skip the script entirely.

Parse the JSON output. Confirm the backup ref and which files were removed.

### 4. Draft the PR

Analyze the commit log and diff stats. Write a concise, semantic PR title (under 70 chars)
and a body with:

```markdown
## Summary
- [1-3 bullet points describing what changed and why]

## Test plan
- [How to verify the changes]
```

The title should describe the outcome, not list commits. Focus on the "why" and the "what",
not the "how".

Use **AskUserQuestion** with options:
- "Looks good, create PR"
- "Let me edit the title/description"
- "Abort"

If "Abort": return to the original branch and stop.

### 5. Push the PR branch

Before creating the PR, the head branch must exist on the remote.

Determine which branch to push:
- If a -pr branch was created: push `{branch}-pr`
- If no strip was needed: push the current branch

Use **AskUserQuestion** with options:
- "Push {branch} to origin"
- "Abort"

If approved: `git push -u origin {pr-head}`

### 6. Create the PR

```bash
gh pr create --base main --head {pr-head} --title "..." --body "..."
```

Display the PR URL.

### 7. Return to original branch

Always return to the original feature branch:
```bash
git checkout {original-branch}
```

### 8. Ask about next step

Use **AskUserQuestion** with options:
- "Merge now (invoke /ship-merge)"
- "Wait for review"

If "Merge now": instruct to invoke `/ship-merge`.

## Rules

- Never push without asking.
- Never delete branches without confirmation.
- Backup before every destructive operation (the script handles this with --backup).
- Always return to the original branch, even on error or abort.
- PR title must be semantic -- not a list of commit messages.
