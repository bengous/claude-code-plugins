---
name: claude-md-improver
description: Audits and improves CLAUDE.md files across a repository. Use when the user asks to check, audit, update, improve, or fix CLAUDE.md files, or mentions "CLAUDE.md maintenance" or "project memory optimization". Scans all memory files (CLAUDE.md, .claude/rules/, @imports), evaluates quality, outputs a report, then applies approved targeted updates.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Edit
  - Write
  - AskUserQuestion
  - Skill
---

# CLAUDE.md Improver

Audit, evaluate, and improve CLAUDE.md files across a codebase so Claude Code has optimal project context.

**This skill can write to memory files.** After presenting a quality report and getting user approval, it applies targeted updates.

Distinctive scope: multi-file scanning, quality assessment against templates, and applying updates. When the user asks for an instruction-budget or anti-pattern audit, invoke `Skill(agent-context-audit:context-audit)` instead; if it is not installed, fall back to the rubric here.

Use Bash only for read-only verification (e.g. confirming a documented command exists in `package.json` or a Makefile) — never execute build, test, or migration commands on the user's repo.

## Workflow

### Phase 1: Discovery

Find memory files with Glob: `**/CLAUDE.md`, `**/CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md`, `**/AGENTS.md`, plus `**/.claude.local.md` (legacy check — that leading-dot name is never loaded). Glob has no exclude parameter: post-filter results, dropping any path containing `node_modules/` or other vendored directories.

Resolve `@path` imports in each file and include their targets; flag imports whose target does not exist. Import semantics: paths resolve relative to the importing file, max 4 hops deep; code spans and fenced code blocks are skipped by the parser.

AGENTS.md: Claude Code reads CLAUDE.md, not AGENTS.md. If a repo keeps its memory in AGENTS.md, verify the bridge exists — a CLAUDE.md containing `@AGENTS.md`, or a symlink — and flag it if missing.

**Memory files in load order** (broadest scope to most specific — a project instruction appears in context after a user instruction):

| Scope | Location | Loading |
|-------|----------|---------|
| Managed policy | e.g. `/etc/claude-code/CLAUDE.md` (OS-specific) | At launch, first; org-wide |
| User | `~/.claude/CLAUDE.md` | At launch; all projects |
| User rules | `~/.claude/rules/**/*.md` | At launch, before project rules |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md` | At launch, plus parent dirs (root-down) |
| Project rules | `.claude/rules/**/*.md` | No `paths:` → at launch, same priority as `.claude/CLAUDE.md`; with `paths:` → when matching files are read |
| Local | `./CLAUDE.local.md` | At launch, appended after CLAUDE.md at the same level; gitignored personal prefs |
| Nested | `<subdir>/CLAUDE.md` (+ `.local`) | On demand, when Claude reads files in that subdir |
| Imports | `@path` in any of the above | At launch, with the importing file |

### Phase 2: Quality Assessment

Evaluate each file against the rubric in [references/quality-criteria.md](references/quality-criteria.md).

**Checklist (points mirror the rubric):**

| Criterion | Points | Check |
|-----------|--------|-------|
| Commands/workflows documented | 20 | Are build/test/deploy commands present? |
| Architecture clarity | 20 | Can Claude understand the codebase structure? |
| Non-obvious patterns | 10 | Are gotchas and quirks documented? |
| Conciseness | 10 | No verbose explanations or obvious info? |
| Currency | 15 | Does it reflect current codebase state? |
| Actionability | 15 | Are instructions executable, not vague? |
| Structure | 10 | Under ~200 lines, thematic rules split into `.claude/rules/`? |

For module/package-level CLAUDE.md files, Commands is N/A (the Package template has none) — rebase the score on the remaining 80 points.

**Grades:** A (90-100), B (70-89), C (50-69), D (30-49), F (0-29).

### Phase 3: Quality Report

**ALWAYS output the report BEFORE making any updates.**

```
## CLAUDE.md Quality Report

### Summary
- Files found: X
- Average score: X/100
- Files needing update: X

### File-by-File Assessment

#### 1. ./CLAUDE.md (Project Root)
**Score: XX/100 (Grade: X)**

| Criterion | Score | Notes |
|-----------|-------|-------|
| Commands/workflows | XX/20 | ... |
| Architecture clarity | XX/20 | ... |
| Non-obvious patterns | XX/10 | ... |
| Conciseness | XX/10 | ... |
| Currency | XX/15 | ... |
| Actionability | XX/15 | ... |
| Structure | XX/10 | ... |

**Issues:** [specific problems]
**Recommended additions:** [what should be added]

### Cross-file Findings
[dead @-import targets, missing AGENTS.md bridge, legacy `.claude.local.md`
files, empty `.claude/rules/`, content duplicated across memory files]
```

### Phase 4: Targeted Updates

Propose only genuinely useful additions; keep them minimal. Full inclusion/exclusion rules, placement guidance, and diff format: [references/update-guidelines.md](references/update-guidelines.md). When a file exceeds the documented ~200-line target — or carries thematic rule sets regardless of size — propose moving thematic sections to `.claude/rules/<topic>.md` files — with `paths:` frontmatter where the content is file-type-specific, since a rules file without `paths:` still loads unconditionally and saves no context (organization only).

For each change show the target file, the addition as a diff, and a one-line reason.

### Phase 5: Apply

Use AskUserQuestion to confirm, then apply approved changes with Edit (or Write for new files such as `.claude/rules/<topic>.md`), preserving existing structure. If AskUserQuestion is unavailable (headless run), present the diffs and stop — apply nothing. Never commit — the user commits manually.

## Templates

CLAUDE.md templates by project type: [references/templates.md](references/templates.md).

## Common Issues to Flag

1. **Stale commands**: build/test commands that no longer work
2. **Stale references**: files, paths, or `@`-import targets that no longer exist
3. **Outdated architecture**: spot-check documented paths and structure claims against the real tree
4. **Missing environment setup**: scan `.env*` files and env-var reads (e.g. `process.env`) for undocumented required vars
5. **Undocumented gotchas**: opportunistic — note what analysis surfaces, no deep scan
6. **Monolithic root file**: over ~200 lines with thematic content that belongs in `.claude/rules/`
7. **Legacy `.claude.local.md`**: the leading-dot name is never loaded — rename to `CLAUDE.local.md`
