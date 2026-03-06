---
name: context-audit
description: |
  Audit CLAUDE.md and AGENTS.md files against research-backed best practices.
  Scores instruction budget usage, detects anti-patterns, checks for staleness,
  and generates concrete fix proposals. Treats CLAUDE.md and AGENTS.md equally.
  Use when user asks to audit, check, review, or optimize context files.
  Also use when user mentions "instruction budget" or "context file quality".
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
Agent context files (CLAUDE.md, AGENTS.md, .claude/rules/) are always-on prompt context injected at session start. Research established that:

- Frontier models follow ~150-200 instructions with reasonable consistency
- Claude Code's system prompt consumes ~50 instruction slots, leaving ~100-150 for user content
- Instruction adherence degrades linearly as count increases — affecting ALL instructions uniformly
- Context files that impose unnecessary requirements can reduce task success rates vs no context at all
- The most effective files are under 100 lines with high directive density

This skill audits context files and produces concrete fix proposals — not just scores, but exact changes with rationale, budget impact estimates, and confidence levels.

The workflow separates **deterministic checks** (file existence, import traversal, symlink detection — high confidence) from **heuristic judgment** (instruction counting, generic advice detection, rewrite proposals — medium confidence). This distinction is labeled in the output.
</context>

<constraints>
- Never auto-commit changes — always require explicit user approval
- Never delete content without presenting it to the user first
- Label every finding with its confidence source (deterministic vs heuristic)
- Use approximate counts (`~N`) for heuristic measurements, not false precision
- Treat CLAUDE.md and AGENTS.md identically — same methodology, same budget
- Do not flag Claude Code native references as stale (slash commands, skills, ${CLAUDE_PLUGIN_ROOT}, Task/Agent calls)
- Read reference files (default-behaviors.md, anti-patterns.md) before running heuristic checks
</constraints>

<workflow>

## Phase 1: Discovery & Import Resolution
**Type: Deterministic**

### 1.1 Find all context files

```bash
# Repo context files
find . -name "CLAUDE.md" -o -name "AGENTS.md" -o -name ".claude.local.md" 2>/dev/null | grep -v node_modules | grep -v .git/

# Rules files
ls .claude/rules/*.md 2>/dev/null

# Global context
ls ~/.claude/CLAUDE.md 2>/dev/null
```

### 1.2 Classify each file

| Type | Location | Always-on? |
|------|----------|-----------|
| Root | `./CLAUDE.md` or `./AGENTS.md` | Yes |
| Rules (path-scoped) | `.claude/rules/*.md` with `paths:` frontmatter | Only when matching files accessed |
| Rules (always-on) | `.claude/rules/*.md` without `paths:` frontmatter | Yes |
| Subdirectory | `packages/*/CLAUDE.md` etc. | Only when files in that dir accessed |
| Global | `~/.claude/CLAUDE.md` | Yes (all projects) |
| Local override | `.claude.local.md` | Yes (but gitignored) |

Check rules files for `paths:` in YAML frontmatter to classify as scoped vs always-on.

### 1.3 Detect symlinks and duplicates

```bash
# Check if any context files are symlinks
readlink -f ./CLAUDE.md 2>/dev/null
readlink -f ./AGENTS.md 2>/dev/null
```

If both CLAUDE.md and AGENTS.md exist:
- If one is a symlink to the other: note as best practice, audit the canonical file only
- If both are independent files: flag duplication risk, compare content hashes:
  ```bash
  md5sum ./CLAUDE.md ./AGENTS.md 2>/dev/null
  ```

### 1.4 Resolve @file imports

For each context file, scan for `@path/to/file` import patterns:
1. Read the file and extract all `@`-prefixed references that look like file paths
2. Resolve paths relative to the file's directory
3. Verify each imported file exists (`test -e`)
4. Read imported files and recursively check for further imports
5. Track import depth to detect circular references (max depth: 5)
6. Mark imported files as "always-on via import" — they count against the root budget

### 1.5 Build file inventory

Present inventory to user:

```
## File Inventory

| # | File | Type | Always-on? | Imported by | Lines |
|---|------|------|-----------|-------------|-------|
| 1 | ./CLAUDE.md | Root | Yes | — | 52 |
| 2 | .claude/rules/01-behavioral.md | Rules (always-on) | Yes | — | 18 |
| 3 | .claude/rules/skills/skill-patterns.md | Rules (scoped) | No (paths: **/skills/**) | — | 40 |
| ...
```

---

## Phase 2: Instruction Budget Scoring
**Type: Heuristic (LLM judgment)**

Read each always-on file and count directives.

### Counting methodology

A "directive" is a discrete behavioral instruction the model must track:

- **Bullet/list item with imperative verb** = 1 directive
  - "Use bun over npm" → 1
  - "Branch naming: feature/description, fix/description" → 1 (single constraint with examples)
- **Compound bullet** = count sub-directives
  - "Keep solutions minimal: no speculative features, error handling for impossible cases, or abstractions for one-time operations" → 3 sub-directives
  - Split on: semicolons, comma-separated imperative clauses, period-separated sentences
- **Prescriptive table row** = 1 directive per row
- **Code block** = 0 (reference data, not a directive)
  - Exception: if prefaced by "Run this..." or "Always execute...", the preface is the directive
- **Header** = 0 (organizational)
- **Context paragraph** without imperative verbs = 0 (informational)
- **YAML frontmatter** = 0

For imported files via `@file`, count their directives and attribute to the importing file's budget.

### Confidence

Directive counting is inherently approximate. Flag ambiguous items:
- "Is this a directive or context?" — when unclear, count it
- Compound instructions — note the split rationale
- State your confidence: HIGH (clear directives), MEDIUM (some ambiguity), LOW (mostly judgment calls)

### Scoring bands

These are heuristic guidelines from research, not hard limits:

| File Type | Comfortable | Elevated | High pressure |
|-----------|-------------|----------|---------------|
| Root context file | <80 directives | 80-120 | >120 |
| Root + all @imports | <100 | 100-130 | >130 |
| Rules file (path-scoped) | <30 | 30-50 | >50 |
| Rules file (always-on) | <20 | 20-40 | >40 |
| Subdirectory context file | <40 | 40-60 | >60 |
| **Total always-on surface** | **<100** | **100-150** | **>150** |

The "total always-on surface" is the critical metric — everything Claude loads at session start: root file + @imports + always-on rules + global CLAUDE.md.

---

## Phase 3: Deterministic Checks
**Type: Deterministic (mechanical verification)**

These are factual checks. Run them with high confidence.

### 3a. Stale file path references

Extract paths from backtick-wrapped content and prose. For each path:

```bash
# Check tracked files
git ls-files --error-unmatch "path/to/file" 2>/dev/null

# Check untracked files
test -e "path/to/file"
```

**Skip these** (valid at runtime, not verifiable now):
- Paths containing `${CLAUDE_PLUGIN_ROOT}` or other variable interpolation
- `~/.claude/` paths (user-specific)
- Paths inside code block examples (illustrative, not references)

### 3b. Stale command references

Extract commands from code blocks and inline backticks.

**For package manager commands** (`npm run X`, `bun run X`, `pnpm run X`, `yarn X`):
```bash
# Verify script exists in nearest package.json
cat package.json | grep -q '"X"' 2>/dev/null
```

**For npx/bunx commands**: verify package in dependencies.

**Do NOT flag as stale:**
- Slash commands (`/command-name`) — Claude Code native
- Skill invocations (`Skill(skill: "name")`) — Claude Code native
- `${CLAUDE_PLUGIN_ROOT}/...` — plugin-relative, resolved at runtime
- `Task(...)` / `Agent(...)` calls — Claude Code tool syntax
- `git` commands — always available
- Standard POSIX commands (`ls`, `cat`, `find`, `test`, etc.) — always available
- Commands with variable interpolation (`$VARIABLE`, `${VAR}`)

### 3c. Linter config detection

```bash
# Check for linter/formatter configs
ls biome.json biome.jsonc 2>/dev/null
ls .eslintrc* eslint.config.* 2>/dev/null
ls .prettierrc* prettier.config.* 2>/dev/null
ls .editorconfig 2>/dev/null
ls deno.json deno.jsonc 2>/dev/null
ls ruff.toml 2>/dev/null
grep -l "tool.ruff\|tool.black" pyproject.toml 2>/dev/null
```

Record which tools are configured — pass to Phase 4 for overlap detection.

### 3d. Progressive disclosure inventory

- Does `.claude/rules/` exist? How many files? How many have `paths:` frontmatter?
- Are there subdirectory CLAUDE.md/AGENTS.md files?
- Does the root file use `@file` imports?
- Detect monorepo:
  ```bash
  # Multiple package.json files
  find . -name "package.json" -not -path "*/node_modules/*" | wc -l
  # Workspace directories
  ls -d packages/ apps/ 2>/dev/null
  ```

---

## Phase 4: Anti-Pattern Detection
**Type: Heuristic (LLM judgment, informed by Phase 3 results)**

Before running these checks, read both reference files:
- `references/default-behaviors.md`
- `references/anti-patterns.md`

### Check 1: Linter overlap (HIGH impact)

Using linter configs detected in Phase 3c, cross-reference with context file content.

For each style directive in the context file, check if it overlaps with a detected linter's domain (see anti-patterns.md for keyword patterns).

Proposal: REMOVE — "Already enforced by [tool] via [config]"

### Check 2: Generic advice (MEDIUM impact)

Compare directives against `default-behaviors.md`. Apply two tests:

1. **Default behavior match**: Does the directive tell Claude to do something it already does?
2. **Specificity test**: Does the directive contain at least one project-specific token (file path, tool name, library name, custom term, concrete command)?

A directive that matches a default behavior AND has no project-specific tokens is generic advice.

Proposal: REMOVE — "Fails deletion test: Claude already does this by default"

### Check 3: Verbose content (MEDIUM-HIGH impact)

Scan for:
- Directives >30 words — propose concise rewrite
- Code blocks >10 lines embedded inline — propose file reference instead
- `@file` imports of files >50 lines — propose converting to "see X" reference
- Sections with <0.3 directive density (more prose than directives)

Proposal: REWRITE with concise version, or convert embed to reference

### Check 4: Non-universal instructions (MEDIUM impact)

Scan for directives that reference specific areas of the codebase:
- Mentions of specific subdirectories (`src/api/`, `packages/ui/`)
- Conditional language ("when working on X", "for X projects", "if using X")
- Framework-specific rules that apply to only part of the codebase

Estimate scope: what fraction of files does this directive affect?

Proposal: MOVE to `.claude/rules/[name].md` with `paths:` frontmatter

### Check 5: Negative instructions without alternatives (MEDIUM impact)

Scan for negative keywords (never, don't, avoid, must not) without accompanying positive alternatives (instead, prefer, use, rather) in the same or immediately following line.

Proposal: REWRITE with positive framing and alternative

---

## Phase 5: Structural Analysis
**Type: Mixed (deterministic inventory + heuristic assessment)**

Using Phase 3d results:

### Progressive disclosure assessment

- If root file exceeds ~100 directives AND no `.claude/rules/` or subdirectory files exist:
  → Recommend progressive disclosure structure
- If monorepo detected AND no subdirectory context files:
  → Recommend per-package context files
- If `@file` imports exist:
  → Show budget breakdown: root content vs imported content

### Section coverage

Check for high-value sections (from research on what matters most):

| Section | Value | Why |
|---------|-------|-----|
| Commands (build/test/lint) | HIGH | Most impactful — saves agent from discovering commands |
| Testing approach | HIGH | Prevents wrong test framework/patterns |
| Gotchas/Warnings | HIGH | Prevents repeating debugging sessions |
| Architecture/Structure | MEDIUM | Helps navigation but agent can often infer |
| Code style | LOW (if linter exists) | Linter handles this |

Flag missing HIGH-value sections as suggestions (not issues).

### Cross-file assessment

- CLAUDE.md + AGENTS.md without symlink → flag duplication risk
- Multiple CLAUDE.md files with overlapping content → flag redundancy

---

## Phase 6: Generate Proposals

Consolidate all findings from Phases 2-5 into concrete proposals.

### Proposal format

Every proposal uses one of four action types:

```
REMOVE: Lines X-Y
Content: "[exact content]"
Reason: [why — specific anti-pattern or check result]
Budget impact: Recovers ~N directive slots
Confidence: HIGH/MEDIUM
Source: [Phase 3a/3b/4.1/4.2/etc.]

MOVE: Lines X-Y → [target path]
Content: "[section or directive]"
Reason: [applies to <20% of codebase / only relevant in specific context]
Suggested target file:
  ---
  paths: [glob pattern]
  ---
  [moved content]
Budget impact: Recovers ~N directive slots from always-on surface
Confidence: MEDIUM
Source: [Phase 4.4]

REWRITE: Line X
Before: "[current version]"
After: "[proposed version]"
Reason: [verbose → concise / adds missing alternative / converts embed to reference]
Budget impact: [token savings / improved adherence]
Confidence: MEDIUM
Source: [Phase 4.3/4.5]

FLAG: Line X
Content: "[content]"
Issue: [stale path, broken command, ambiguous scope]
Suggestion: [what to investigate or decide]
Confidence: HIGH/MEDIUM
Source: [Phase 3a/3b/5]
```

### Prioritization

Order proposals by impact:
1. **Budget recovery** — REMOVE and MOVE proposals that free directive slots
2. **Correctness** — FLAG proposals for stale references and broken commands
3. **Efficiency** — REWRITE proposals for verbosity and negative-without-alternative
4. **Structure** — Suggestions for progressive disclosure and missing sections

---

## Phase 7: Output Report

### Tier 1: Executive Summary (always show)

```
## Context Audit: [file path]

### Always-On Budget
Root directives:       ~X  (confidence: HIGH/MEDIUM)
Via @imports:          ~X  (N files)
Always-on rules:       ~X  (N files)
Global CLAUDE.md:      ~X
────────────────────────────
Total always-on:       ~X / ~100 recommended   [Comfortable / Elevated / High pressure]

File size: X lines

### Health Checks
| Check                | Type          | Result | Details |
|----------------------|---------------|--------|---------|
| Instruction budget   | Heuristic     | ...    | ~X directives |
| Stale references     | Deterministic | ...    | N broken paths, M broken commands |
| Linter overlap       | Mixed         | ...    | N style rules overlap with [tool] |
| Verbosity            | Heuristic     | ...    | Density: 0.XX (target >0.3) |
| Progressive disc.    | Deterministic | ...    | N rules files, M path-scoped |
| Negative w/o alt     | Heuristic     | ...    | N dead-end negatives |
| Generic advice       | Heuristic     | ...    | N directives fail deletion test |

### Quick Wins (top 3 by budget impact)
1. [proposal summary] (~N slots recovered)
2. [proposal summary] (~N slots recovered)
3. [proposal summary] (~N slots recovered)

Projected after quick wins: ~X / ~100
```

### Tier 2: Full Proposals

Every proposal with complete detail, grouped by action type. Show confidence level and source phase for each.

### Tier 3: Action Plan

Consolidated execution order:

```
### Action Plan (N proposals)

#### Phase 1: Remove (HIGH confidence first)
1. [stale reference removals — deterministic]
2. [linter overlap removals — high confidence]
3. [generic advice removals — medium confidence]

#### Phase 2: Move to progressive disclosure
4. [non-universal instructions → path-scoped rules]

#### Phase 3: Rewrite
5. [verbose → concise]
6. [negative → positive with alternative]

#### Phase 4: Manual Review
7. [FLAG items needing human judgment]

### Projected Budget After All Changes
Total always-on: ~X / ~100 recommended   [new status]
```

---

## Phase 8: Apply Changes (with approval)

Present the action plan and ask user which proposals to apply:

Options:
1. **Apply all high-confidence proposals** — deterministic fixes only
2. **Apply quick wins only** — top 3 by budget impact
3. **Apply by category** — choose which anti-pattern types to fix
4. **Review individually** — go through proposals one by one
5. **Save report only** — write report to file, apply nothing

For each approved proposal:
- Use Edit tool for targeted modifications
- For MOVE proposals: create the target file with frontmatter, then remove from source
- Show before/after for each change
- Never auto-commit

After applying, show updated summary:
```
Applied: N proposals
Skipped: M proposals
New always-on budget: ~X / ~100 recommended

Consider committing these changes and running /context-audit again to verify.
```

</workflow>
