---
description: Review PR comments - fix bad naming, preserve necessary context
argument-hint: "[PR_REFERENCE]"
allowed-tools:
  - Read(*:*)
  - Edit(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - Bash(git:*)
  - Bash(gh:*)
model: claude-opus-4-5
---

# Clean PR Comments

Review comments in a PR. Fix comments that compensate for bad naming. Preserve comments that provide context code cannot express.

## Decision Framework

| Comment compensates for... | Action |
|---------------------------|--------|
| Bad variable/function name | Rename, remove comment |
| Missing abstraction | Extract to well-named function, remove comment |
| External knowledge | **Keep** |
| Inherent complexity | **Keep** |

## Remove After Refactoring

Comments that explain WHAT code does—these are naming problems:

- `int d; // days elapsed` → rename to `elapsedDays`
- `// check if user can access premium` before condition → extract to `canAccessPremium()`
- `setTimeout(fn, 86400000); // 24 hours` → `const ONE_DAY_MS = 86400000`

## Keep

Comments that explain what code CANNOT express:

- **Business rules:** `// FCC requires 30-day retention minimum`
- **External quirks:** `// Safari bug, see webkit#12345`
- **Performance:** `// Intentionally avoiding map() - 10x faster here`
- **History:** `// Tried recursion but hit stack limits`
- **Spec constants:** `// 0x1F frame delimiter per RFC 7230`
- **Warnings:** `// Order matters - auth before session init`
- **License headers and public API docs**

## Remove Immediately

- Commented-out code (use git history)
- Restates code literally: `i++ // increment i`
- TODOs that should be tickets

## Workflow

1. **Identify scope:**
   ```bash
   git diff --stat origin/main...HEAD
   ```

2. **Select strategy based on PR size:**
   - **≤10 files:** Process sequentially yourself
   - **>10 files:** Spawn parallel agents (see Scaling below)

3. **Read each file**, identify all comments

4. **Present findings before editing:**
   ```
   src/auth.js:
     L45: "// convert to uppercase" → REMOVE (obvious from code)
     L67: "// api timeout" → REFACTOR: rename `t` to `apiTimeoutMs`
     L89: "// Safari workaround #234" → KEEP (external quirk)
   ```

5. **Implement** after user confirms

6. **Verify** tests pass

## Scaling

For PRs with >10 files, divide work across parallel agents:

1. **Group files** by directory or logical area

2. **Spawn one subtask per group** with this prompt:
   ```
   Review comments in these files only: [FILE_LIST]

   For each comment found, output ONE line:
   PATH:LINE: "comment text" → REMOVE|REFACTOR|KEEP (reason)

   For REFACTOR, include the rename: `oldName` → `newName`

   Do not edit files. Report findings only.
   ```

3. **Collect results** from all agents

4. **Present consolidated findings** to user

5. **Implement** after confirmation

## Constraints

- Never remove context comments (business rules, external quirks, warnings)
- Never change behavior—only rename/extract for clarity
- When uncertain, keep the comment
- Don't add abstractions just to avoid a one-line comment
