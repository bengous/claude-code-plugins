# Proposal & Report Formats

Templates for Phase 6 (Generate Proposals) and Phase 7 (Output Report).

## Proposal action types

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

## Tier 1: Executive Summary (always show)

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

## Tier 2: Full Proposals

Every proposal with complete detail, grouped by action type. Show confidence level and source phase for each.

## Tier 3: Action Plan

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

## Post-apply summary (Phase 8)

```
Applied: N proposals
Skipped: M proposals
New always-on budget: ~X / ~100 recommended

Consider committing these changes and running the audit again to verify.
```
