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

ADD: [target file] → [section name]
Content: "[proposed content — shape from references/templates.md]"
Grounded in: [the Phase 3 artefact: undocumented script / env var / package / architecture drift]
Reason: [what this saves a future agent from re-discovering]
Budget impact: Costs +N directive slots
Financed by: [REMOVE/MOVE proposal #X | projected budget headroom]
Confidence: HIGH/MEDIUM
Source: [Phase 3b/3d/3e/3f]

FLAG: Line X
Content: "[content]"
Issue: [stale path, broken command, ambiguous scope, content decay]
Suggestion: [what to investigate or decide]
Confidence: HIGH/MEDIUM
Source: [Phase 3a/3b/4.6/5]
```

`Budget impact` is signed against the always-on surface: REMOVE and MOVE recover slots, ADD
costs them. An ADD with no `Grounded in:` artefact is not a valid proposal.

Any proposal whose validity depends on resolving a FLAG carries `Contingent on: FLAG #N` and its
budget impact is excluded from the projected total until that FLAG is settled. When including or
excluding a contingent recovery moves the projection across a band boundary, report both figures
under a `Sensitivity:` line — the band is what gates ADD, so the ambiguity is decision-relevant.

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

`Result` holds a per-check verdict — Pass / Warn / Fail. It is never counted, ratioed, or
summed: "4/10 passing" is an aggregate score by another name, and the constraint forbids it.

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

Every proposal with complete detail, grouped by action type. Show confidence level and source phase for each. Then, per file and across files:

```
#### ./CLAUDE.md (Project root, always-on, ~X directives)
**Issues:** [specific problems found in this file]
**Recommended additions:** [what is missing, each naming its Phase 3 artefact]

### Cross-file Findings
[dead @-import targets, missing AGENTS.md bridge, legacy `.claude.local.md` files,
empty `.claude/rules/`, content duplicated across memory files]

### Deferred Additions
[additions held back because the projected budget stayed outside the Comfortable band —
named, with their slot cost, but not offered for application]
```

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

#### Phase 4: Financed additions
7. [ADD proposals, applied last so they land against the real post-pruning budget]

#### Phase 5: Manual Review
8. [FLAG items needing human judgment]

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
