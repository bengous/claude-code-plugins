---
description: Make code self-documenting by improving naming and structure. Removes comments that compensate for unclear code.
argument-hint: "[file-pattern] [--apply]"
allowed-tools:
  - Read(*:*)
  - Edit(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - Bash(git:*)
model: claude-opus-4-5
---

# Clean Comments

Make code self-documenting. Fix the code that needs comments as a crutch.

## Decision Framework

| Comment compensates for... | Action |
|---------------------------|--------|
| Bad variable/function name | **REFACTOR**: Rename, remove comment |
| Missing abstraction | **REFACTOR**: Extract to well-named function |
| Magic number | **REFACTOR**: Extract to named constant |
| External knowledge | **KEEP** (business rules, browser quirks, RFCs) |
| Inherent complexity | **KEEP** (warnings, order dependencies) |
| Nothing (restates code) | **REMOVE** |

## Mode Selection

Parse `$ARGUMENTS`:
- Contains `--apply` → Execute mode (apply approved changes)
- Otherwise → Proposal mode (analyze and present, no edits)

## Workflow

### 1. Identify Files

- Use file pattern from arguments, or `git diff --name-only HEAD~5` for recent changes
- Focus on code files (js, ts, py, go, rs, java, etc.)

### 2. Analyze Each Comment

For every comment, ask: "What is this compensating for?"

**REFACTOR candidates** (comment masks a code problem):
- `int d; // elapsed days` → Code problem: bad name
- `// check premium access` → Code problem: missing abstraction
- `86400000 // one day in ms` → Code problem: magic number

**KEEP candidates** (comment adds external context):
- `// FCC requires 30-day retention` — Business rule
- `// Safari bug, see webkit#12345` — External quirk
- `// Order matters - auth before session` — Warning
- `// 0x1F delimiter per RFC 7230` — Spec reference

**REMOVE candidates** (no value, no code fix needed):
- `i++ // increment i` — Restates code literally
- Commented-out code blocks — Use git history
- Stale TODOs — Should be tickets

### 3. Present Findings

Group by file, prioritize REFACTOR suggestions:

```
## src/billing.ts

### REFACTOR (4 suggestions)
- L45: `let d; // days until due` → Rename `d` to `daysUntilDue`
- L67: `// apply discount if premium` → Extract to `shouldApplyPremiumDiscount(user)`
- L89: `* 86400000 // ms per day` → Create `const MS_PER_DAY = 86400000`
- L102: `let t; // timeout` → Rename `t` to `requestTimeoutMs`

### KEEP (2 comments)
- L34: `// GDPR Article 17 - right to erasure` — Legal requirement
- L156: `// setTimeout needed - direct call causes race` — Warning

### REMOVE (1 comment)
- L23: `return result; // return the result` — Restates code

---
Summary: 4 refactorings, 2 kept, 1 removal
```

### 4. Await Confirmation

Ask: "Apply these changes? You can also specify which categories (e.g., 'only refactorings', 'skip L89')"

### 5. Execute (if --apply or user confirms)

Apply approved changes:
1. Perform renames/extractions (REFACTOR items)
2. Remove redundant comments (REMOVE items)
3. Leave KEEP items untouched

## Constraints

- Never remove context comments (business rules, quirks, warnings)
- When uncertain, keep the comment
- Don't over-abstract: skip extraction if it would create a trivial one-liner function
- Renames should follow existing codebase conventions
