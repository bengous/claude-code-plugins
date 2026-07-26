---
name: context-audit
description: >
  Audits CLAUDE.md and AGENTS.md files against research-backed best practices:
  instruction budget scoring, anti-pattern detection, staleness checks, and
  concrete fix proposals. Use when the user asks to audit, check, review, or
  optimize context files, or mentions "instruction budget" or "context file
  quality". Treats CLAUDE.md and AGENTS.md identically.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(ls:*, test:*, git:*, cat:*, wc:*, head:*, readlink:*, realpath:*, find:*, md5sum:*)
  - AskUserQuestion
  - Edit
  - Write
---

# Context Audit

<context>
Context files (CLAUDE.md, AGENTS.md, .claude/rules/) are always-on prompt context. Research baseline: frontier models follow ~150-200 instructions with reasonable consistency; Claude Code's system prompt consumes ~50 slots, leaving ~100-150 for user content. Adherence degrades linearly with instruction count — affecting ALL instructions uniformly — and files that impose unnecessary requirements can reduce task success versus no context file at all. The most effective files are under 100 lines with high directive density.

Output is concrete fix proposals — exact changes with rationale, budget impact, and confidence — not just scores. Deterministic checks (file existence, import traversal, symlinks) are labeled separately from heuristic judgment (directive counting, generic-advice detection).
</context>

<constraints>
- Never auto-commit; never delete content without presenting it to the user first
- Label every finding deterministic vs heuristic; use `~N` for heuristic counts, not false precision
- Treat CLAUDE.md and AGENTS.md identically — same methodology, same budget
- Never flag Claude Code native references as stale — slash commands, skill invocations, `${CLAUDE_PLUGIN_ROOT}` paths, `Agent` calls (full list in `references/anti-patterns.md`). Exception: `@file` import syntax is native, but missing import targets are still findings (Phase 1 verifies them)
- Read both reference files before Phase 4
</constraints>

<workflow>

## Phase 1: Discovery & Import Resolution (deterministic)

1. Find context files: `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md` anywhere in the repo (exclude `node_modules/`, `.git/`), plus `.claude/rules/*.md` and `~/.claude/CLAUDE.md`.
2. Classify each file:

| Type | Location | Always-on? |
|------|----------|-----------|
| Root | `./CLAUDE.md` or `./AGENTS.md` | Yes |
| Rules (path-scoped) | `.claude/rules/*.md` with `paths:` frontmatter | Only when matching files accessed |
| Rules (always-on) | `.claude/rules/*.md` without `paths:` | Yes |
| Subdirectory | `packages/*/CLAUDE.md` etc. | Only when that dir accessed |
| Global | `~/.claude/CLAUDE.md` | Yes (all projects) |
| Local override | `CLAUDE.local.md` | Yes (gitignored) |

3. Symlinks: `readlink -f` on CLAUDE.md/AGENTS.md. One symlinked to the other → best practice, audit the canonical file only. Both independent → flag duplication risk, compare `md5sum`.
4. Resolve `@file` imports recursively (resolve relative to the importing file, verify each target with `test -e`, max depth 5 to catch cycles). Imported files are always-on and count against the importer's budget.
5. Present a file inventory table: file, type, always-on?, imported by, lines.

## Phase 2: Instruction Budget Scoring (heuristic)

Count directives — discrete behavioral instructions the model must track — in each always-on file:

- Bullet/list item with imperative verb = 1 ("Branch naming: feature/desc, fix/desc" = 1 constraint with examples)
- Compound bullet = count sub-directives; split on semicolons, comma-separated imperative clauses, period-separated sentences
- Prescriptive table row = 1 per row
- Code blocks, headers, non-imperative prose, YAML frontmatter = 0 (a "Run this..." preface IS the directive)
- `@file` imports: count their directives into the importer's budget

When unsure whether something is a directive, count it — and flag ambiguous items in the report. Note split rationale for compounds. State confidence: HIGH (clear directives), MEDIUM (some ambiguity), LOW (mostly judgment calls).

Scoring bands (heuristic guidelines, not hard limits):

| File Type | Comfortable | Elevated | High pressure |
|-----------|-------------|----------|---------------|
| Root context file | <80 | 80-120 | >120 |
| Root + all @imports | <100 | 100-130 | >130 |
| Rules file (path-scoped) | <30 | 30-50 | >50 |
| Rules file (always-on) | <20 | 20-40 | >40 |
| Subdirectory context file | <40 | 40-60 | >60 |
| **Total always-on surface** | **<100** | **100-150** | **>150** |

Total always-on surface is the critical metric: root + @imports + always-on rules + global CLAUDE.md.

## Phase 3: Deterministic Checks

- **3a. Stale paths**: extract paths from backticks and prose; verify with `git ls-files --error-unmatch` then `test -e`. Skip paths with variable interpolation (`${CLAUDE_PLUGIN_ROOT}`, `$VAR`), `~/.claude/` paths, and paths inside illustrative code blocks.
- **3b. Stale commands**: extract commands from code blocks and inline backticks. For `npm run X` / `bun run X` / `pnpm run X` / `yarn X`, verify the script exists in the nearest package.json; for npx/bunx, verify the package is a dependency. Never flag native references (`references/anti-patterns.md`), git, standard POSIX commands, or commands with variable interpolation.
- **3c. Linter configs**: detect configured linters/formatters (detection table in `references/anti-patterns.md` §1) — feeds Phase 4 Check 1.
- **3d. Structure inventory**: `.claude/rules/` file count and `paths:` frontmatter; subdirectory context files; `@file` imports; monorepo signals (multiple package.json excluding `node_modules/`, `packages/`/`apps/` dirs) — feeds Phase 5.

## Phase 4: Anti-Pattern Detection (heuristic)

Read `references/default-behaviors.md` and `references/anti-patterns.md`, then run the five checks. Detection keywords, examples, and proposal templates are in the anti-patterns catalog.

| # | Check | Impact | Trigger | Proposal |
|---|-------|--------|---------|----------|
| 1 | Linter overlap | HIGH | Style directive covered by a linter detected in 3c | REMOVE |
| 2 | Generic advice | MEDIUM | Matches a default behavior AND has zero project-specific tokens | REMOVE |
| 3 | Verbose content | MEDIUM-HIGH | Directive >30 words; inline code block >10 lines; `@file` import >50 lines; directive density <0.3 (file or section) | REWRITE |
| 4 | Non-universal instructions | MEDIUM | Directive scoped to <20% of the codebase (subdirectory mentions, "when working on X") — strong MOVE candidate | MOVE to path-scoped rule |
| 5 | Negative without alternative | MEDIUM | never/don't/avoid with no instead/prefer/use in the same or next line | REWRITE |

## Phase 5: Structural Analysis (mixed)

Using Phase 3 inventory:

- Root >~100 directives AND no `.claude/rules/` or subdirectory files → recommend progressive disclosure
- Monorepo detected AND no subdirectory context files → recommend per-package context files
- `@file` imports present → show budget breakdown: root vs imported
- Section coverage — flag missing HIGH-value sections as suggestions (not issues): Commands (build/test/lint) HIGH, Testing approach HIGH, Gotchas/warnings HIGH, Architecture MEDIUM, Code style LOW when a linter exists
- CLAUDE.md + AGENTS.md unsymlinked, or multiple CLAUDE.md files with overlapping content → flag redundancy

## Phase 6: Generate Proposals

Consolidate Phases 2-5 into proposals using four action types — REMOVE, MOVE, REWRITE, FLAG — each with exact content, reason, budget impact, confidence, and source phase. Templates in `references/output-format.md`.

Prioritize: 1) budget recovery (REMOVE/MOVE), 2) correctness (FLAG stale refs), 3) efficiency (REWRITE), 4) structure suggestions.

## Phase 7: Output Report

Three tiers (full templates in `references/output-format.md`):

1. **Executive summary** (always show): always-on budget breakdown vs ~100 recommended, health-check table, top-3 quick wins with projected budget
2. **Full proposals**: every proposal grouped by action type, with confidence and source phase
3. **Action plan**: execution order — removes (HIGH confidence first), moves, rewrites, manual-review flags — with projected final budget

## Phase 8: Apply Changes (with approval)

Ask the user which proposals to apply: all high-confidence (deterministic fixes only) / quick wins only (top 3 by budget impact) / by category (choose which anti-pattern types) / individually / save report only.

For each approved proposal: use Edit for targeted changes; for MOVE, create the target rules file with `paths:` frontmatter before removing from source; show before/after. Never auto-commit. Close with the applied/skipped counts and new budget, and suggest re-running the audit after committing.

</workflow>
