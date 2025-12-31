---
description: Synchronize project CLAUDE.md with recent codebase changes by analyzing git history, reviewing against official Anthropic best practices using parallel agents, and proposing comprehensive updates. Use when CLAUDE.md is outdated or doesn't exist.
allowed-tools:
  - Bash(git:*)
  - Skill
---

# Sync CLAUDE.md

Synchronize your project's CLAUDE.md file with codebase evolution through automated git analysis and parallel agent review.

<context>
CLAUDE.md serves as project memory for AI assistants. When it becomes outdated:
- Claude makes decisions based on stale architectural patterns
- New tools, commands, or conventions go undocumented
- Team members receive inconsistent AI assistance

This command analyzes git history since the last CLAUDE.md update and proposes comprehensive changes aligned with official Anthropic best practices.
</context>

<usage>
```bash
/sync-claude-md
```

Natural invocation:
- "Sync CLAUDE.md with recent changes"
- "Update CLAUDE.md to reflect new architecture"
- "Check if CLAUDE.md needs updating"
</usage>

<workflow>
1. **Validate environment:**
   ```bash
   git rev-parse --is-inside-work-tree 2>/dev/null
   ```
   If not a git repo, inform user but offer to create CLAUDE.md anyway.

2. **Invoke the skill:**
   ```
   Skill(skill: "sync-claude-md")
   ```
   Provide context: project directory and git repo status.

3. **Verify and report:**
   - Confirm skill invocation succeeded
   - Report completion status: success, user rejected changes, or error
   - If error occurred, surface the failure reason
</workflow>

<constraints>
- Let the skill manage user approval - it handles the approval workflow
- Let the skill manage all CLAUDE.md file operations
- Let the skill instruct users to commit manually
- Report skill completion status to the user
</constraints>

The skill handles: git history analysis, parallel agent review (3 agents), official documentation validation, change proposal generation, user approval workflow, and file updates.
