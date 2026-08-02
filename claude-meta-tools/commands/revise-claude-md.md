---
description: Captures this session's learnings (commands, gotchas, patterns) into CLAUDE.md or .claude/rules/. Use at the end of a session worth persisting. For drift against codebase evolution, use /sync-claude-md instead.
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
---

Review this session for learnings about working with Claude Code in this codebase. Update project memory with context that would help future Claude sessions be more effective.

Scope boundary: this command captures **current-session learnings**. Syncing CLAUDE.md against git history and codebase evolution is `/sync-claude-md`'s job.

## Step 1: Reflect

What context was missing that would have helped Claude work more effectively?
- Bash commands that were used or discovered
- Code style patterns followed
- Testing approaches that worked
- Environment/configuration quirks
- Warnings or gotchas encountered

## Step 2: Find Memory Files

Use Glob: `**/CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md`, `CLAUDE.local.md`. Also check discovered files for `@path` imports pointing to other memory files.

Decide where each addition belongs:
- `CLAUDE.md` - Team-shared, always-on (checked into git); nested ones scope to their directory
- `.claude/rules/<topic>.md` - Team-shared thematic rules; an existing rules file covering the topic wins over CLAUDE.md, and prefer a new one over growing an already-long CLAUDE.md
- Personal/local only - gitignored `CLAUDE.local.md` (loads alongside CLAUDE.md; append to it if present); for prefs shared across worktrees, a home-dir file imported via `@~/...`. Note: `@path` imports are composition, not privacy — a versioned import target is team-visible.

## Step 3: Draft Additions

**Keep it concise** - one line per concept. CLAUDE.md is part of the prompt, so brevity matters.

Format: `<command or pattern>` - `<brief description>`

Avoid:
- Verbose explanations
- Obvious information
- One-off fixes unlikely to recur

## Step 4: Show Proposed Changes

For each addition:

```
### Update: [target file]

**Why:** [one-line reason]

\`\`\`diff
+ [the addition - keep it brief]
\`\`\`
```

## Step 5: Apply with Approval

Ask if the user wants to apply the changes. Do not call Edit or Write before approval; only touch files they approve.
