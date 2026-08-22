# Git Tools Plugin

Interactive git commands with AI assistance for commit management and history rewriting.

## Overview

Git Tools provides AI-powered interactive git commands that enhance your workflow with intelligent suggestions, visual feedback, and safety guardrails.

## Features

- **Interactive Rebase**: Visual, multi-stage rebase workflow driven by questions instead of an editor
- **PR Triage**: Analyze open PRs and decide to treat or close with explanatory comments
- **Issue Triage**: Analyze open issues with fact-checking and decide to treat or close
- **Repository Cleanup**: Automated cleanup of stale branches, worktrees, and closed PRs
- **Commit Messages**: Claude proposes reword and squash messages, and you pick one
- **Conflict Guidance**: Step-by-step resolution instructions when conflicts arise
- **Safety Checks**: Automatic backup branch creation and working directory validation
- **Visual Feedback**: A rendered rebase plan, confirmed before execution

## Installation

This plugin is part of the bengous-plugins marketplace. To install:

1. Add the marketplace to your Claude Code configuration
2. Install the git-tools plugin from the marketplace

## Commands

> Branch and worktree cleanup moved to the `git-sweep` plugin (`/git-sweep`), which
> supersedes the former `/analyze-git` and `/cleanup-git` commands. See
> `archive/git-legacy/` for the retired versions.

### `/triage`

Analyze an open pull request and decide whether to treat (continue working on it) or close it with an explanatory comment.

**Usage:**
```bash
/git-tools:triage 123                              # By PR number
/git-tools:triage https://github.com/org/repo/pull/123  # By URL
```

**Analysis Criteria:**

| Factor | What's Evaluated |
|--------|------------------|
| Age & Activity | Creation date, last update, staleness |
| Scope | Files changed, lines added/removed |
| Review Status | Approvals, change requests, pending reviews |
| Merge Readiness | Conflicts, CI status, target branch |
| Relevance | Alignment with current project goals |

**Workflow:**

1. **Gather**: Fetches PR metadata, diff stats, and comments via `gh` CLI
2. **Analyze**: Evaluates the PR against triage criteria
3. **Summarize**: Presents structured report with recommendation
4. **Decide**: Asks you to confirm TREAT or CLOSE
5. **Execute**:
   - TREAT: Optionally assign, label, or comment
   - CLOSE: Posts explanatory comment, then closes PR

**Output Example:**
```
## PR Summary: Add dark mode support

**Author:** @contributor | **Created:** 45 days ago | **Last activity:** 30 days ago

**Scope:** +250/-50 lines across 8 files

**Status:**
- Reviews: changes requested
- Mergeable: yes
- CI: passing

**Key observations:**
- Stale for 30 days with unaddressed review comments
- Significant scope but well-structured changes
- No response from author to feedback

**Recommendation:** CLOSE
**Reason:** Stale PR with unaddressed review feedback
```

**Close Comment Templates:**

The command includes templates for common close scenarios:
- Stale PRs (no recent activity)
- Superseded PRs (work done elsewhere)
- Scope issues (PR too large to review)

Comments thank the contributor and invite them to reopen if circumstances change.

**Requirements:**
- GitHub CLI (`gh`) authenticated with repo access

---

### `/issue-triage`

Analyze an open issue and decide whether to treat (continue working on it) or close it with an explanatory comment.

**Usage:**
```bash
/git-tools:issue-triage 123                              # By issue number
/git-tools:issue-triage https://github.com/org/repo/issues/123  # By URL
```

**Key Differences from PR Triage:**

| Aspect | PR Triage | Issue Triage |
|--------|-----------|--------------|
| Fact-checking | Merge conflicts, CI status | Verify issue still exists in codebase |
| Closure reasons | Comment only | `--reason completed` or `--reason not_planned` |
| Actions | Assign, label, request changes | Assign, label, milestone, link PRs |

**Analysis Criteria:**

| Factor | What's Evaluated |
|--------|------------------|
| Age & Activity | Creation date, last update, staleness |
| Clarity | Description quality, reproduction steps |
| Labels & Assignment | Proper categorization, ownership |
| Relevance | Alignment with current project goals |
| Validity | Whether issue still exists in codebase |

**Workflow:**

1. **Gather**: Fetches issue metadata, labels, and comments via `gh` CLI
2. **Fact-check**: Verifies issue is still valid (searches codebase, checks for fixes)
3. **Analyze**: Evaluates the issue against triage criteria
4. **Summarize**: Presents structured report with recommendation
5. **Decide**: Asks you to confirm TREAT or CLOSE
6. **Execute**:
   - TREAT: Optionally assign, label, add to milestone, or comment
   - CLOSE: Posts explanatory comment with appropriate reason

**Close Reasons:**

- `--reason completed`: Issue was fixed or feature implemented
- `--reason not_planned`: Won't fix, duplicate, cannot reproduce, stale, invalid

**Close Comment Templates:**

The command includes templates for common close scenarios:
- Already fixed (resolved elsewhere)
- Duplicate (link to original issue)
- Cannot reproduce (request more info)
- Stale (no recent activity)
- Won't fix (out of scope or by design)

**Requirements:**
- GitHub CLI (`gh`) authenticated with repo access

---

### `/rebase`

Interactive git rebase with visual planning and reworked commit messages.

**Usage:**
```bash
/rebase 5               # The last 5 commits (HEAD~5)
/rebase main            # Every commit since the merge base with main
/rebase abc123..def456  # Every commit since abc123
/rebase continue        # After resolving a conflict
/rebase skip            # Drop the commit that conflicts
/rebase abort           # Undo the whole rebase
/rebase status          # Where a paused rebase stands
```

The branch form edits the commits made since the merge base. It does not move
the branch onto that branch's tip; `git rebase main` does that.

**Workflow:**

1. **Plan**: The backend lists the commits in the range, oldest first
2. **Choose Actions**: For each commit, answer:
   - `Pick`: Keep commit as-is
   - `Squash`: Combine with the commit above it
   - `Reword`: Change the commit message
   - `Drop`: Remove commit
3. **Review Plan**: The rendered plan is shown before anything runs
4. **Execute**: A backup branch is created, then the rebase runs with no editor

**Commit messages:**

Claude reads the commit and proposes reword or squash messages: the original,
a conventional-commit form when the history uses one, and a shorter subject.
You choose one or write your own — nothing is applied without that answer.
No separate model is called, and no suggestion is generated that you do not see.

**Safety:**

- Validates working directory is clean before starting
- Creates automatic backup branch (`rebase-backup-<branch>-<timestamp>`)
- Re-checks the plan against the branch at execution time and refuses a stale one
- Provides conflict resolution guidance if issues arise

**Example:**

```bash
/rebase 3

# Rebase plan — base 19b31bc
#
#   ✎ REWORD b0c153d feat: add parser
#            └─ message: feat(parser): add the expression parser
#   ⬆ SQUASH b63623d fix typo
#            └─ folded into the commit above
#   ✗ DROP   6d2e3bc chore: wip debug
#
# Summary: 0 pick, 1 squash, 1 reword, 1 drop
#
# Run this rebase? [Run / Cancel]
```

## Requirements

- Git 2.0+
- GitHub CLI (`gh`) authenticated for PR operations
- jq (for `/bisect-ci`)
- Clean working directory for rebase operations

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
