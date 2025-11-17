---
description: Synchronize project CLAUDE.md with recent codebase changes by analyzing git history, reviewing against official Anthropic best practices using parallel agents, and proposing comprehensive updates. Use when CLAUDE.md is outdated or doesn't exist.
---

# Sync CLAUDE.md

Synchronize your project's CLAUDE.md file with codebase evolution through automated git analysis and parallel agent review.

## Usage

```bash
/sync-claude-md
```

**Natural invocation:**
- "Sync CLAUDE.md with recent changes"
- "Update CLAUDE.md to reflect new architecture"
- "Check if CLAUDE.md needs updating"

---

## Your Task

**Step 1: Validate Environment**

Check if we're in a git repository:
```bash
git rev-parse --is-inside-work-tree 2>/dev/null
```

If not a git repo, inform user but offer to create CLAUDE.md anyway.

**Step 2: Invoke Skill**

```
Skill(skill: "sync-claude-md")
```

**Step 3: Provide Context**

```
CLAUDE.md Sync Request:
- Project: [current working directory]
- Git repo: [yes/no]
```

Done. The skill handles:
- Git history analysis
- Parallel agent review (3 agents)
- Official documentation validation
- Change proposal generation
- User approval workflow
- File updates
