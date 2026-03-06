---
description: Audit CLAUDE.md/AGENTS.md against research-backed best practices with instruction budget scoring
argument-hint: "[file-path]"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(ls:*, test:*, git:*, cat:*, wc:*, head:*, readlink:*, realpath:*, find:*)
  - Skill
  - AskUserQuestion
model: opus
---

# Context Audit

Audit agent context files (CLAUDE.md, AGENTS.md) against research-backed best practices. Scores instruction budget usage, detects anti-patterns, checks for staleness, and generates concrete fix proposals.

<context>
Agent context files (CLAUDE.md, AGENTS.md) are always-on prompt injections that compete for a finite instruction budget. Research shows frontier models follow ~150-200 instructions with reasonable consistency, and Claude Code's system prompt consumes ~50, leaving ~100-150 for user content. Files that exceed this budget or contain anti-patterns (linter overlap, generic advice, stale references) cause uniform degradation of adherence to ALL instructions.

This command audits context files and produces actionable proposals — not just scores, but exact changes with rationale and confidence levels.
</context>

<workflow>

## Step 1: Discover context files

**$ARGUMENTS**

If a file path was provided, audit that specific file.

If no argument, discover all context files:

```bash
# Find repo context files
find . -name "CLAUDE.md" -o -name "AGENTS.md" -o -name ".claude.local.md" 2>/dev/null | grep -v node_modules | grep -v .git/ | head -30

# Find rules files
ls -la .claude/rules/*.md 2>/dev/null

# Check global context
ls -la ~/.claude/CLAUDE.md 2>/dev/null
```

Present the discovered files to the user and ask which to audit (default: all root-level files).

## Step 2: Invoke the audit skill

```
Skill(skill: "context-audit")
```

Pass the list of files to audit. The skill handles all phases: import resolution, budget scoring, deterministic checks, anti-pattern detection, proposal generation, and reporting.

## Step 3: Report completion

After the skill completes, confirm:
- How many files were audited
- How many proposals were generated
- Whether any changes were applied
- Suggest running again after applying changes to verify improvement

</workflow>

<constraints>
- Let the skill manage user approval for changes — it handles the approval workflow
- Let the skill manage all file edits
- Never auto-commit changes
- Report skill completion status to the user
</constraints>
