# Verification Agents

Post-implementation verification using 3 parallel subagents.

## Overview

After implementation completes, spawn all 3 agents **in a single message** with multiple Task calls. This runs them in parallel.

## 1. Compliance Agent

**Subagent type**: `Explore`

**Purpose**: Verify implementation matches the plan exactly.

```
Verify the implementation matches the plan.

Plan location: [path to plan file]

Checklist:
1. All files listed in the plan were created/modified
2. No files outside the plan scope were touched
3. Commit messages match what was specified
4. Acceptance criteria are satisfied

Output: COMPLIANT or list specific deviations with file paths.
```

## 2. Best Practices Agent

**Subagent type**: `general-purpose`

**Purpose**: Validate implementation against official documentation.

```
Research the implementation against best practices.

Modified files: [list paths]
Technologies used: [frameworks, libraries]

Tasks:
1. Use WebSearch to find official documentation for each technology
2. Use Context7 (if loaded) for framework-specific patterns
3. Compare implementation against recommended patterns
4. Flag deprecated APIs, anti-patterns, or gotchas

Output: ALIGNED or list concerns with documentation links.
```

**Note**: If Context7 is not loaded, run `mcp-add context7` first or rely on WebSearch.

## 3. Code Simplifier Agent

**Subagent type**: `code-simplifier`

**Purpose**: Review for over-engineering and suggest simplifications.

```
Review the modified files for simplification opportunities.

Modified files: [list paths]

Look for:
- Unnecessary abstractions (premature DRY)
- Premature optimization
- Excessive error handling for impossible cases
- Code that could be expressed more simply

Output: OPTIMAL or list specific simplification suggestions with file:line references.
```

## Spawning Pattern

In a **single message**, make 3 Task tool calls:

```
Task(
  subagent_type: "Explore",
  description: "Compliance check",
  prompt: "[compliance prompt with plan path and file list]"
)

Task(
  subagent_type: "general-purpose",
  description: "Best practices check",
  prompt: "[best practices prompt with files and technologies]"
)

Task(
  subagent_type: "code-simplifier",
  description: "Simplification review",
  prompt: "[simplifier prompt with file list]"
)
```

## Interpreting Results

| Agent | Pass | Fail Action |
|-------|------|-------------|
| Compliance | COMPLIANT | Fix deviations, re-run |
| Best Practices | ALIGNED | Evaluate suggestions, fix critical issues |
| Code Simplifier | OPTIMAL | Apply worthwhile simplifications |

If all 3 pass, verification is complete. If any fail, address issues and re-run verification.
