# Issue Commands

Reference for all 8 GitHub issue management commands.

## Overview

Issue commands integrate with GitHub Issues for task tracking and orchestration. All commands use the GitHub CLI (`gh`) under the hood.

## Command List

1. [/issue](#issue) - List issues with filters
2. [/issue:create](#issuecreate) - Create new issue
3. [/issue:view](#issueview) - View issue details
4. [/issue:comment](#issuecomment) - Add comment
5. [/issue:label](#issuelabel) - Manage labels
6. [/issue:close](#issueclose) - Close issue
7. [/issue:reopen](#issuereopen) - Reopen issue
8. [/issue:fetch](#issuefetch) - Fetch and sync with orchestration

---

## /issue

**Description:** List GitHub issues with filtering options.

**Usage:**
```bash
/issue [options]
/issue:list [options]  # Alias
```

**Options:**
- `--state open|closed|all` - Filter by state (default: `open`)
- `--label <label>` - Filter by label
- `--assignee <user>` - Filter by assignee
- `--author <user>` - Filter by author
- `--limit N` - Limit number of results (default: 20)

**Examples:**
```bash
# List open issues
/issue

# List all issues
/issue --state all

# Filter by label
/issue --label bug

# Filter by multiple criteria
/issue --state open --label enhancement --assignee me

# Get more results
/issue --limit 50
```

**Output:**
```
Open Issues (5):

#42 - Implement user authentication
      Labels: enhancement, security, priority:high, status:in_progress
      Author: bengous
      Updated: 2025-10-09

#38 - Fix login validation bug
      Labels: bug, priority:medium, status:available
      Author: contributor
      Updated: 2025-10-08

#35 - Add dark mode support
      Labels: enhancement, frontend, priority:low, status:available
      Author: bengous
      Updated: 2025-10-05

[... more issues ...]
```

---

## /issue:create

**Description:** Create a new GitHub issue with labels and metadata.

**Usage:**
```bash
/issue:create issue-title="..." [options]
```

**Arguments:**
- `issue-title` (required) - Title for the issue

**Options:**
- `description="..."` - Detailed description
- `labels="..."` - Comma-separated labels
- `priority=high|medium|low` - Priority level (default: `medium`)
- `assignee=<user>` - Assign to user

**Auto-Added Labels:**
- `ai-task` - Marks as AI-managed task
- `priority:{level}` - Priority label
- `status:available` - Initial status

**Examples:**
```bash
# Simple issue
/issue:create issue-title="Fix authentication bug"

# Full context
/issue:create issue-title="Add dark mode support" \
              description="Implement dark mode with system preference detection" \
              labels="enhancement,frontend" \
              priority=high

# With assignment
/issue:create issue-title="Refactor auth module" \
              priority=medium \
              assignee=bengous
```

**Output:**
```
Creating issue...

Issue created: #45
Title: Add dark mode support
URL: https://github.com/user/repo/issues/45
Labels: enhancement, frontend, ai-task, priority:high, status:available
```

**Related:**
- `/orc:start` - Use with `--issue N` to link orchestration

---

## /issue:view

**Description:** View detailed information about a specific issue.

**Usage:**
```bash
/issue:view <number>
```

**Arguments:**
- `<number>` (required) - Issue number

**Examples:**
```bash
/issue:view 42
```

**Output:**
```
Issue #42: Implement user authentication

Status: OPEN
Author: bengous
Assignee: none
Created: 2025-10-08
Updated: 2025-10-09

Labels:
  • enhancement
  • security
  • ai-task
  • priority:high
  • status:in_progress

Description:
  Implement JWT-based authentication system with:
  - User login/logout
  - Token refresh
  - OAuth integration (Google, GitHub)
  - Role-based access control

Comments (3):
  [2025-10-09 14:30] bengous:
    Starting implementation with /orc:start

  [2025-10-09 15:45] bengous:
    Core auth module completed in PR #123

  [2025-10-09 16:20] bengous:
    OAuth integration in progress

Pull Requests:
  • #123 - Core auth module (MERGED to feat/auth-system)
  • #124 - OAuth providers (OPEN to feat/auth-system)
```

---

## /issue:comment

**Description:** Add a comment to an issue.

**Usage:**
```bash
/issue:comment <number> <message>
```

**Arguments:**
- `<number>` (required) - Issue number
- `<message>` (required) - Comment text

**Examples:**
```bash
/issue:comment 42 "Starting work on this issue"
/issue:comment 42 "Core implementation complete, moving to tests"
```

**Output:**
```
Adding comment to issue #42...
Comment added successfully!
```

**Use Cases:**
- Progress updates during orchestration
- Notes about implementation decisions
- Questions or blockers

---

## /issue:label

**Description:** Add or remove labels from an issue.

**Usage:**
```bash
/issue:label <number> --add <labels>
/issue:label <number> --remove <labels>
```

**Arguments:**
- `<number>` (required) - Issue number

**Options:**
- `--add <labels>` - Comma-separated labels to add
- `--remove <labels>` - Comma-separated labels to remove

**Examples:**
```bash
# Add labels
/issue:label 42 --add "in-progress,needs-review"

# Remove labels
/issue:label 42 --remove "status:available"

# Add and remove
/issue:label 42 --add "status:completed" --remove "status:in_progress"
```

**Output:**
```
Updating labels for issue #42...
Added: in-progress, needs-review
Removed: status:available
Labels updated successfully!
```

**Common Labels:**
- **Status**: `status:available`, `status:in_progress`, `status:completed`
- **Priority**: `priority:high`, `priority:medium`, `priority:low`
- **Type**: `bug`, `enhancement`, `documentation`
- **Area**: `frontend`, `backend`, `api`, `database`

---

## /issue:close

**Description:** Close an issue with optional comment.

**Usage:**
```bash
/issue:close <number> [comment="..."]
```

**Arguments:**
- `<number>` (required) - Issue number
- `comment="..."` (optional) - Closing comment

**Examples:**
```bash
# Simple close
/issue:close 42

# Close with comment
/issue:close 42 comment="Completed in PR #124"
```

**Output:**
```
Closing issue #42...
Issue closed successfully!
```

**Best Practices:**
- Link to PR that resolves the issue
- Summarize what was accomplished
- Note any follow-up issues

---

## /issue:reopen

**Description:** Reopen a closed issue with optional comment.

**Usage:**
```bash
/issue:reopen <number> [comment="..."]
```

**Arguments:**
- `<number>` (required) - Issue number
- `comment="..."` (optional) - Reopening reason

**Examples:**
```bash
# Reopen
/issue:reopen 42

# Reopen with reason
/issue:reopen 42 comment="Found regression, needs additional work"
```

**Output:**
```
Reopening issue #42...
Issue reopened successfully!
```

---

## /issue:fetch

**Description:** Fetch issue details and sync with orchestration state.

**Usage:**
```bash
/issue:fetch <number>
```

**Arguments:**
- `<number>` (required) - Issue number

**Purpose:**
Synchronizes issue metadata with orchestration system for context.

**Examples:**
```bash
/issue:fetch 42
```

**Output:**
```
Fetching issue #42...

Issue: Implement user authentication
Status: open
Labels: enhancement, security, priority:high
Assignee: none

Synced with orchestration state.
```

**Use Case:**
Called automatically by `/orc:start --issue N` to load context.

---

## Integration with Orchestration

### Issue-Driven Development Workflow

```bash
# 1. Create issue
/issue:create issue-title="Add user profile page" \
              description="Create user profile with avatar, bio, settings" \
              priority=high

# → Issue #50 created

# 2. Start orchestration with issue
/orc:start "Implement user profile page" --issue 50 --confirm

# → Automatically:
#   • Fetches issue context
#   • Links PRs to issue
#   • Updates issue with progress

# 3. Issue gets updated automatically:
#   • Comments added during execution
#   • Labels updated (status:in_progress)
#   • PRs linked

# 4. Close when complete
/issue:close 50 comment="Completed in PR #126"
```

### Worktree + Issue Integration

```bash
# Create worktree linked to issue
/worktree:create profile-page --issue 50 --agent me --lock

# Work in worktree...

# Status tracking
/issue:comment 50 "Profile UI implemented in worktree/50-profile-page-me"

# Create PR
/pr:create --head worktree/50-profile-page-me --base dev

# Close issue
/issue:close 50 comment="Completed in PR #127"
```

## Label Conventions

### Status Labels

| Label | Meaning |
|-------|---------|
| `status:available` | Ready to be worked on |
| `status:in_progress` | Currently being implemented |
| `status:blocked` | Waiting on dependencies |
| `status:completed` | Implementation finished |
| `status:wontfix` | Issue will not be addressed |

### Priority Labels

| Label | SLA | Use Case |
|-------|-----|----------|
| `priority:high` | ASAP | Critical bugs, blockers |
| `priority:medium` | Normal | Standard features/bugs |
| `priority:low` | When possible | Nice-to-have improvements |

### Type Labels

| Label | Description |
|-------|-------------|
| `bug` | Something is broken |
| `enhancement` | New feature or improvement |
| `documentation` | Docs updates |
| `refactor` | Code restructuring |
| `test` | Testing improvements |

### AI-Specific Labels

| Label | Purpose |
|-------|---------|
| `ai-task` | Managed by AI orchestration |
| `needs-human-review` | Requires human attention |
| `automated` | Fully automated task |

## Advanced Filtering

### Complex Queries

```bash
# High priority bugs
/issue --state open --label bug --label priority:high

# Available tasks
/issue --state open --label status:available

# My assigned issues
/issue --assignee @me --state open

# Recent activity
/issue --state all --limit 10
```

### Scripting with JSON

```bash
# Get JSON output for scripting
gh issue list --json number,title,labels,state --limit 100 | \
  jq '.[] | select(.labels[].name == "ai-task")'
```

## Best Practices

1. **Clear Titles**
   - Be specific and actionable
   - Good: "Add OAuth login with Google provider"
   - Bad: "Login stuff"

2. **Detailed Descriptions**
   - Include acceptance criteria
   - List technical requirements
   - Mention dependencies

3. **Label Consistently**
   - Always set priority
   - Update status as work progresses
   - Add type labels (bug/enhancement)

4. **Link to PRs**
   - Reference issue number in PR title
   - Use GitHub keywords: "Closes #N", "Fixes #N"

5. **Progress Updates**
   - Comment on significant milestones
   - Note blockers immediately
   - Summarize when closing

---

**Next:** [Orchestration Commands](orchestration.md) for task delegation.
