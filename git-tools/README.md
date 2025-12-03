# Git Tools Plugin

Interactive git commands with AI assistance for commit management and history rewriting.

## Overview

Git Tools provides AI-powered interactive git commands that enhance your workflow with intelligent suggestions, visual feedback, and safety guardrails.

## Features

- **Interactive Rebase**: Visual, multi-stage rebase workflow with AI-powered commit improvements
- **PR Triage**: Analyze open PRs and decide to treat or close with explanatory comments
- **Issue Triage**: Analyze open issues with fact-checking and decide to treat or close
- **Repository Cleanup**: Automated cleanup of stale branches, worktrees, and closed PRs
- **Smart Commit Messages**: AI suggestions for reword operations following conventional commit patterns
- **Conflict Guidance**: Step-by-step resolution instructions when conflicts arise
- **Safety Checks**: Automatic backup branch creation and working directory validation
- **Visual Feedback**: ASCII graphs showing your rebase plan before execution

## Installation

This plugin is part of the bengolea-plugins marketplace. To install:

1. Add the marketplace to your Claude Code configuration
2. Install the git-tools plugin from the marketplace

## Commands

### `/analyze-git`

Analyze your git repository for cleanup opportunities. This is a READ-ONLY command that identifies:

- Local branches marked as `[gone]` (remote deleted)
- Prunable worktrees
- Dependabot PRs that are closed/merged but still have branches
- Overall branch inventory

**Usage:**
```bash
/git-tools:analyze-git
```

**Output:**
- Comprehensive report of cleanup opportunities
- Branch counts and specific names
- No modifications performed

**Follow-up:** Use `/git-tools:cleanup-git` after reviewing the analysis.

---

### `/cleanup-git`

Perform git repository cleanup based on `/analyze-git` findings.

**IMPORTANT:** This command performs DESTRUCTIVE operations. Always run `/git-tools:analyze-git` first.

**Usage:**
```bash
/git-tools:cleanup-git
```

**Operations:**
1. Remove worktrees and delete branches marked as `[gone]`
2. Prune stale worktrees
3. Clean up closed/merged dependabot branches
4. Provide cleanup summary

**Safety:**
- Preserves main/dev/master branches
- Preserves current branch
- Preserves active dependabot PRs (OPEN status)
- Cannot be easily undone - use with caution

---

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

Interactive git rebase with visual planning and AI-powered commit improvements.

**Usage:**
```bash
/rebase              # Rebase entire branch from merge-base
/rebase 5            # Rebase last 5 commits (HEAD~5)
/rebase abc123       # Rebase from specific commit/branch
/rebase abc123..def456  # Rebase specific range
```

**Workflow:**

1. **Select Range**: Choose what to rebase (entire branch, N commits, or custom range)
2. **Review Commits**: See all commits in the range with details
3. **Choose Actions**: For each commit, select:
   - `pick` (p): Keep commit as-is
   - `squash` (s): Combine with previous commit
   - `reword` (r): Edit commit message (AI suggestions provided)
   - `drop` (d): Remove commit
4. **Review Plan**: See visual graph of planned changes
5. **Execute**: Automatic backup branch created, rebase performed

**AI Features:**

- **Reword Suggestions**: When rewording, receive 3 AI-generated options:
  - Keep original
  - Improved clarity
  - Concise version
  - Or write custom message

- **Smart Squash Messages**: When squashing commits, AI analyzes all commit messages and generates an intelligent combined message following conventional commit patterns

**Safety:**

- Validates working directory is clean before starting
- Creates automatic backup branch (`backup-<branch>-<timestamp>`)
- Checks for unpushed commits
- Provides conflict resolution guidance if issues arise

**Example:**

```bash
/rebase 3

# Output:
# Rebase interactive mode - Last 3 commits
#
# Commit 1: a1b2c3d Add user authentication
# Action [p/s/r/d/?]: p
#
# Commit 2: d4e5f6g Fix login bug
# Action [p/s/r/d/?]: s
#
# Commit 3: g7h8i9j Update tests
# Action [p/s/r/d/?]: r
#
# Rebase Plan:
# ✓ PICK   a1b2c3d Add user authentication
# ⬆ SQUASH d4e5f6g Fix login bug
# ✎ REWORD g7h8i9j Update tests
#
# Proceed? (y/n)
```

## Requirements

- Git 2.0+
- GitHub CLI (`gh`) authenticated for PR operations
- jq (for JSON processing)
- Clean working directory for rebase operations

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
