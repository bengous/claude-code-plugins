---
description: Audit a Biome/ESLint lint rule - research best practices, analyze violations, generate fix strategy
argument-hint: "<rule-name> (e.g., noLeakedRender, noContinue)"
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - WebFetch
  - WebSearch
  - Agent
  - AskUserQuestion
  - mcp__Context7__resolve-library-id
  - mcp__Context7__query-docs
---

# Lint Rule Audit

**Rule:** $ARGUMENTS

## Your Task

Audit the rule through the phases below: research best practices, analyze the violations in this codebase, and end with actionable recommendations.

## Phase 1: Discovery

<context>
Before researching best practices, establish the scope of the problem. Knowing the violation count and distribution guides how deep to investigate—a single violation warrants less research than hundreds across the codebase.
</context>

Run the lint command to find all violations:

```bash
# Try common lint scripts - adapt to project
bun run lint:only $ARGUMENTS 2>/dev/null || \
bunx biome lint --only=nursery/$ARGUMENTS . 2>/dev/null || \
bunx biome lint --only=style/$ARGUMENTS . 2>/dev/null || \
bunx biome lint --only=suspicious/$ARGUMENTS .
```

Capture and report:
- Total violation count (errors, warnings, infos)
- Number of files affected
- Primary locations (which directories/modules)

When zero violations are found, report:
> **No violations found** for `$ARGUMENTS` in this codebase. The rule is either not enabled or the code already complies.

Then proceed directly to the Decision phase (Phase 6) with "Do nothing" as the recommended option.

## Phase 2: Research

<context>
Understanding a rule requires multiple perspectives: the official rationale, community consensus, and framework-specific guidance. Primary sources (Biome CLI) are fast and authoritative; secondary sources add context for controversial or experimental rules.
</context>

### Primary Source: Biome CLI (fast, offline)

```bash
bunx biome explain $ARGUMENTS
```

This provides:
- Summary (name, fix availability, severity, version, category)
- Domains (framework dependencies like react@>=16.0.0)
- Full description
- Invalid examples (what gets flagged)
- Valid examples (correct patterns)

### Secondary Sources

Research these when the rule is in `nursery` (experimental/controversial), the user asks for "best practices" or a "modern approach", or the Biome explanation lacks context on WHY the rule exists:

- **ESLint origin**: the ESLint rule name (it may differ from Biome's), its original rationale, its status (recommended/frozen/deprecated), and a link to its docs.
- **Community sentiment**: whether the rule is controversial, the main arguments for and against it, and notable GitHub issues (airbnb/javascript, biomejs/biome) with their vote counts and links.
- **Framework practice**: which framework the rule concerns (React, Next.js, ...), what its official docs recommend on the underlying concept (Context7), and links.

Each angle takes a few searches. Delegate them to parallel subagents only when one is wide enough to repay a subagent's overhead.

## Phase 3: Code Analysis

<context>
Research tells you what the rule *should* catch. Code analysis reveals what it *actually* catches in this codebase. Discrepancies between theory and practice inform whether to fix, suppress, or disable.
</context>

1. Read 2-3 files with violations to understand the actual patterns being flagged
2. Categorize violations:
   - **Legitimate issues**: Rule correctly flags problematic code
   - **False positives**: Rule flags acceptable/idiomatic patterns
   - **Edge cases**: Debatable, context-dependent
3. Identify the dominant pattern in this codebase

## Phase 4: Present Findings

<context>
The report synthesizes discovery, research, and analysis into an actionable summary. Structure matters—stakeholders need quick answers (violation count, recommendation) before diving into details.
</context>

Structure your report as:

```
## Audit: $ARGUMENTS

### Violations Found
- **Count**: X violations across Y files
- **Severity**: error/warning/info
- **Rule Status**: stable/nursery (experimental)

### Why This Rule Exists
[1-2 paragraph explanation of the problem it solves]

### What the Rule Flags
| Pattern | Example | Flagged Because |
|---------|---------|-----------------|

### Best Practice Consensus
| Source | Position | Notes |
|--------|----------|-------|
| Biome | ... | ... |
| ESLint | ... | ... |
| Community | ... | ... |

### Codebase Analysis
[Analysis of actual violation patterns found]

**Dominant pattern**: [describe]
**Assessment**: [legitimate issues / false positives / mixed]

### Recommendation
| Option | Action | Trade-off |
|--------|--------|-----------|

**Suggested**: [option] because [reasoning]
```

## Phase 5: Generate Fix Prompt

<context>
A well-crafted fix prompt enables autonomous execution with minimal supervision. Include enough context for the subagent to make judgment calls, but constrain scope to prevent over-engineering.
</context>

If fixes are warranted, generate a subagent prompt following current prompting guidance. Include a model recommendation based on fix complexity:
- `model: sonnet` — Simple to moderate (rename, add import, pattern changes across files)
- `model: opus` — Complex refactoring (architectural changes, judgment-heavy decisions)

```markdown
# Fix $ARGUMENTS Violations

<task>
[One sentence describing the transformation]
</task>

<context>
[Why this matters - the underlying problem being solved]
</context>

<fix_patterns>
| Violation Type | Fix Pattern | Example |
|----------------|-------------|---------|
</fix_patterns>

<examples>
<!-- Show 2-3 before/after pairs -->
BEFORE: [code]
AFTER:  [code]
</examples>

<constraints>
- [Hard rules: what NOT to change]
- [Scope limits]
</constraints>

<judgment_call>
[When to suppress with biome-ignore instead of fixing]
</judgment_call>

<success_criteria>
Lint command returns zero violations for this rule.
</success_criteria>
```

## Phase 6: Decision

<context>
Present options with clear trade-offs so the user can make an informed choice. The audit provides the data; the user owns the decision.
</context>

Ask user how to proceed using AskUserQuestion:

**Question:** "How would you like to proceed with $ARGUMENTS?"

**Options:**
1. **Fix all** - Spawn subagent with the generated prompt
2. **Disable rule** - Add rule to biome.json exclusions
3. **Selective ignore** - Add biome-ignore comments to false positives only
4. **Do nothing** - Analysis complete, no action needed

## Success Criteria

A successful audit:
- Reports exact violation count and affected file count from Phase 1
- Provides research findings with clickable source links from Phase 2
- Categorizes violations as legitimate/false positive/edge case from Phase 3
- Delivers structured report matching the template in Phase 4
- Generates ready-to-use subagent prompt if fixes are appropriate (Phase 5)
- Ends with decision prompt for user to choose next steps (Phase 6)
