---
name: context-audit
description: >
  Audits and improves CLAUDE.md, AGENTS.md and .claude/rules/ files: measures instruction
  budget, detects anti-patterns and stale references, then proposes and applies
  REMOVE/MOVE/REWRITE/ADD fixes after approval. Use when the user asks to audit, check,
  review, optimize, improve, update, or fix context or memory files, or mentions
  "instruction budget", "CLAUDE.md maintenance", or "project memory optimization".
  Treats CLAUDE.md and AGENTS.md identically. For syncing content against recent git
  history use sync-claude-md; for capturing a session's learnings use revise-claude-md.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(ls:*, test:*, git:*, cat:*, wc:*, head:*, readlink:*, realpath:*, find:*, md5sum:*, grep:*)
  - AskUserQuestion
  - Edit
  - Write
---

# Context Audit

<context>
Context files (CLAUDE.md, AGENTS.md, .claude/rules/) are always-on prompt context. Research baseline: frontier models follow ~150-200 instructions with reasonable consistency; Claude Code's system prompt consumes ~50 slots, leaving ~100-150 for user content. Adherence degrades linearly with instruction count — affecting ALL instructions uniformly — and files that impose unnecessary requirements can reduce task success versus no context file at all. The most effective files are under 100 lines with high directive density.

Output is concrete fix proposals — exact changes with rationale, budget impact, and confidence. Deterministic checks (file existence, import traversal, symlinks) are labeled separately from heuristic judgment (directive counting, generic-advice detection). The audit prunes and grows in one pass: it removes what costs more than it earns, then proposes additions financed by what the pruning freed.
</context>

<constraints>
- Never auto-commit; never delete content without presenting it to the user first
- Label every finding deterministic vs heuristic; use `~N` for heuristic counts, not false precision
- Never emit a letter grade or an aggregate quality score. A directive count is a measurement and is reported; a grade is a judgment dressed as a number and varies run to run. The health-check table and the budget band carry the summary
- A file with no findings produces a report with no proposals, and that is a complete result. Never promote a near-threshold observation to a proposal to make a thin report look thorough — the user applies what is proposed, so padding costs them real content
- CLAUDE.md and AGENTS.md get identical methodology and budget bands, but AGENTS.md enters the always-on budget only when bridged (Phase 1 verifies `@AGENTS.md` or a symlink) — Claude Code loads CLAUDE.md, not AGENTS.md
- Use Bash only for read-only verification (confirming a documented command exists in `package.json` or a Makefile); never run build, test, or migration commands on the user's repo
- Global files (`~/.claude/`) are discovered and counted, never proposed against: a project audit reports the user-scope figure and stops there. Editing cross-project instructions from inside one repo is out of scope
- Never flag Claude Code native references as stale — slash commands, skill invocations, `${CLAUDE_PLUGIN_ROOT}` paths, `Agent` calls (full list in `references/anti-patterns.md`). Exception: `@file` import syntax is native, but missing import targets are still findings (Phase 1 verifies them)
- Read both reference files before Phase 4
</constraints>

<workflow>

## Phase 1: Discovery & Load Order (deterministic)

1. Glob for `**/CLAUDE.md`, `**/CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md`, `**/AGENTS.md`, plus `**/.claude.local.md` (legacy check — that leading-dot name is never loaded), and add `~/.claude/CLAUDE.md` and `~/.claude/rules/`. Glob has no exclude parameter: post-filter the results, dropping `node_modules/` and other vendored paths.
2. Classify each file against the load order — broadest scope first, so a project instruction lands in context after a user one:

| Scope | Location | Loading | Always-on? |
|-------|----------|---------|------------|
| Managed policy | e.g. `/etc/claude-code/CLAUDE.md` (OS-specific) | At launch, first; org-wide | Yes |
| User | `~/.claude/CLAUDE.md` | At launch | Yes (all projects) |
| User rules | `~/.claude/rules/**/*.md` | At launch, before project rules | Yes |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md` | At launch, plus parent dirs (root-down) | Yes |
| Project rules | `.claude/rules/**/*.md` | No `paths:` → at launch, same priority as `.claude/CLAUDE.md`; with `paths:` → when matching files are read | Only without `paths:` |
| Local | `./CLAUDE.local.md` | At launch, appended after CLAUDE.md at the same level; gitignored personal prefs | Yes |
| Nested | `<subdir>/CLAUDE.md` (+ `.local`) | On demand, when Claude reads files in that subdir | No |
| Imports | `@path` in any of the above | At launch, with the importing file | Follows its importer |

3. Symlinks: `readlink -f` on CLAUDE.md/AGENTS.md. One symlinked to the other → best practice, audit the canonical file only. Both independent → flag duplication risk, compare `md5sum`.
4. Resolve `@path` imports recursively: relative to the importing file, max 4 hops (catches cycles), skipping code spans and fenced blocks. Verify each target with `test -e`. Imported files are always-on and count against the importer's budget.
5. AGENTS.md bridge: when a repo keeps its memory in AGENTS.md, verify the bridge exists — a CLAUDE.md containing `@AGENTS.md`, or a symlink — and flag it if missing. An unbridged AGENTS.md is never loaded, so it stays out of the budget.
6. Present a file inventory table: file, scope, always-on?, imported by, lines.

## Phase 2: Instruction Budget Scoring (heuristic)

Count directives — discrete behavioral instructions the model must track — in each always-on file:

- Bullet/list item stating a behavioral constraint = 1 ("Branch naming: feature/desc, fix/desc" = 1 constraint with examples). An imperative verb is not required: a declarative gotcha the model must respect ("the lexer treats a bare `-` as part of an identifier") is a directive
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

Total always-on surface is the critical metric: root + @imports + always-on rules + global CLAUDE.md. Report it split into **project-owned** and **user-scope** (`~/.claude/`) subtotals: the user's global file lands in every audit on that machine and no repo-level proposal can touch it, so an unsplit total says more about the setup than about the repo. Proposals target the project-owned portion; mention the user-scope figure only if it alone exceeds the band.

## Phase 3: Deterministic Checks

- **3a. Stale paths**: extract paths from backticks and prose; verify with `git ls-files --error-unmatch` then `test -e`. Skip paths with variable interpolation (`${CLAUDE_PLUGIN_ROOT}`, `$VAR`), `~/.claude/` paths, and paths inside illustrative code blocks. Precondition: if `git ls-files` returns no source tree at all, report the empty checkout once and suppress 3a and 3e entirely — on a partial clone these checks turn "the tree is missing" into "the docs are stale", and acting on that deletes accurate documentation.
- **3b. Stale commands**: extract commands from code blocks and inline backticks, and resolve each against the project's declared task runner or manifest: `npm`/`bun`/`pnpm`/`yarn run X` against the nearest package.json `scripts`, npx/bunx against its dependencies, `make X` against the Makefile, `cargo`/`go`/`uv`/`poetry`/`just` against their own manifests. Where the ecosystem offers no such resolution, do not flag — an unverifiable command is not a stale one. Never flag native references (`references/anti-patterns.md`), git, standard POSIX commands, or commands with variable interpolation.
- **3c. Linter configs**: detect configured linters/formatters (detection table in `references/anti-patterns.md` §1) — feeds Phase 4 Check 1 and gates ADD (Phase 6 rule 3).
- **3d. Structure inventory**: `.claude/rules/` file count and `paths:` frontmatter; subdirectory context files; `@file` imports; monorepo signals (multiple package.json excluding `node_modules/`, `packages/`/`apps/` dirs) — feeds Phase 5.
- **3e. Architecture claims**: spot-check documented directory layouts and structure claims against the real tree. A described module that no longer exists is a stale reference, not a style issue.
- **3f. Undocumented environment**: scan `.env*` files and env-var reads (`process.env`, `os.environ`, `std::env`) for required vars absent from the context files. Report the vars, never their values.

Every artefact 3b/3d/3e/3f surfaces is a candidate anchor for an ADD proposal (Phase 6 rule 2).

## Phase 4: Anti-Pattern Detection (heuristic)

Read `references/default-behaviors.md` and `references/anti-patterns.md`, then run the six checks. Detection keywords, examples, and proposal templates are in the anti-patterns catalog.

| # | Check | Impact | Trigger | Proposal |
|---|-------|--------|---------|----------|
| 1 | Linter overlap | HIGH | Style directive covered by a linter detected in 3c | REMOVE |
| 2 | Generic advice | MEDIUM | Matches a default behavior AND has zero project-specific tokens | REMOVE |
| 3 | Verbose content | MEDIUM-HIGH | Directive >30 words; inline code block >10 lines; `@file` import >50 lines; directive density <0.3 (file or section) | REWRITE |
| 4 | Non-universal instructions | MEDIUM | Directive scoped to <20% of the codebase (subdirectory mentions, "when working on X") — strong MOVE candidate | MOVE to path-scoped rule |
| 5 | Negative without alternative | MEDIUM | never/don't/avoid with no instead/prefer/use in the same or next line | REWRITE |
| 6 | Content decay | MEDIUM | Stale tech versions, uncustomized template placeholders, unresolved TODOs, `.claude.local.md`, commit-bound notes (catalog §6) | FLAG |

## Phase 5: Structural Analysis (mixed)

Using the Phase 3 inventory:

- Root >~100 directives **or** >~200 lines, AND no `.claude/rules/` or subdirectory files → recommend progressive disclosure. The two thresholds measure different things: prose-heavy files cross the line count without crossing the directive count.
- When proposing a MOVE to `.claude/rules/<topic>.md`, add `paths:` frontmatter wherever the content is file-type-specific. A rules file **without** `paths:` still loads unconditionally and saves no context — it is organization only, not budget recovery. Say which one a given MOVE buys.
- Monorepo detected AND no subdirectory context files → recommend per-package context files
- `@file` imports present → show budget breakdown: root vs imported
- Section coverage — the value ranking that gates ADD (Phase 6): Commands (build/test/lint) HIGH, Testing HIGH, Gotchas/warnings HIGH, Environment HIGH, Architecture MEDIUM, Key Files MEDIUM, Code style LOW when a linter exists
- CLAUDE.md and AGENTS.md both present but unsymlinked, or multiple CLAUDE.md files with overlapping content → flag redundancy. A repo with no AGENTS.md at all is not a finding

## Phase 6: Generate Proposals

Consolidate Phases 2-5 into proposals using five action types — REMOVE, MOVE, REWRITE, ADD, FLAG — each with exact content, reason, budget impact, confidence, and source phase. Templates in `references/output-format.md`; content shape for additions in `references/templates.md`, inclusion rules in `references/update-guidelines.md`.

**When one line triggers two checks, the deterministic finding wins.** A directive scoped to a path that does not exist is a FLAG first, not a MOVE — relocating it would preserve a rule guarding nothing, and a MOVE onto a dead scope recovers no budget. Same for a dead-end negative naming a missing path (Check 5): FLAG it, and mark the heuristic action `Contingent on:` that FLAG rather than dropping it. Contingent recoveries do not count toward the projected budget until their FLAG is resolved — report both projections when the difference crosses a band boundary. Re-scoping an existing always-on rules file by adding `paths:` frontmatter is typed MOVE (nothing relocates, but the budget semantics are a move).

ADD is not a peer of the other four — it is subordinate and financed. Four rules:

1. **Two passes.** Compute REMOVE/MOVE/REWRITE first, giving a projected budget. Evaluate ADD only against that projected budget, never the current one. Gate on the **project-owned** projected surface, not the grand total: the user's global files are usually the larger share and no repo-level proposal can move them, so gating on the total would let a personal global file veto a well-anchored addition. If the project-owned projection does not land in the Comfortable band, list the additions in the report as deferred and do not offer them for application.
2. **Anchoring is mandatory.** Every ADD cites a concrete artefact found in Phase 3 — an undocumented `package.json`/Makefile script (3b), an undocumented env var (3f), a monorepo package with no context file (3d), an architecture divergence (3e). No artefact, no ADD: unlike removals, which are bounded by what the file contains, additions are unbounded because anything could be said to be missing.
3. **Code style is a hard exception.** When 3c detects a linter, never propose an ADD about style — and an existing style section becomes a REMOVE (Check 1). This is the one place where pruning and growing would otherwise contradict each other.
4. **Signed cost, fixed order.** An ADD's budget impact is **positive** (`+N slots`) — it is a cost, and the projected budget lies if it is not added back. Order the report and the application queue `REMOVE → MOVE → REWRITE → ADD → FLAG`, so additions land against a real budget. Every ADD passes the specificity test in `references/default-behaviors.md` first: an addition the next audit would flag is not an addition.

Prioritize: 1) budget recovery (REMOVE/MOVE), 2) correctness (FLAG stale refs), 3) efficiency (REWRITE), 4) financed additions, 5) structure suggestions.

## Phase 7: Output Report

**Always output the report before making any changes.** Three tiers (full templates in `references/output-format.md`):

1. **Executive summary**: always-on budget breakdown vs ~100 recommended, health-check table, top-3 quick wins with projected budget
2. **Full proposals**: every proposal grouped by action type, with confidence and source phase; per-file Issues and Recommended additions; a Cross-file Findings block (dead `@`-import targets, missing AGENTS.md bridge, legacy `.claude.local.md`, empty `.claude/rules/`, content duplicated across memory files); and Deferred additions when rule 1 held any back
3. **Action plan**: execution order — removes (HIGH confidence first), moves, rewrites, financed adds, manual-review flags — with projected final budget

## Phase 8: Apply Changes (with approval)

Ask the user which proposals to apply: all high-confidence (deterministic fixes only) / quick wins only (top 3 by budget impact) / by category (choose which anti-pattern types) / individually / save report only.

For each approved proposal: use Edit for targeted changes; for MOVE, create the target rules file with `paths:` frontmatter before removing from source; for ADD, follow the section shape in `references/templates.md`; show before/after. If AskUserQuestion is unavailable (headless run), present the diffs and stop — apply nothing. Never auto-commit. Close with the applied/skipped counts and new budget, and suggest re-running the audit after committing.

</workflow>
