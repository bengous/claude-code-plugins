---
name: iaqi
description: Iteratively improve artifacts via parallel reviewers with anchor-based drift prevention. NOT for: one-shot edits, simple fixes, tasks without measurable quality. USE for: skills, prompts, commands, agents needing iterative refinement with score targets. Triggers: "iterate to 9.0", "quality loop", "IAQI", "reviewer loop", "improve until threshold", "iterative quality".
---

Intent-Anchored Quality Iteration (IAQI) prevents semantic drift during iterative improvement. The problem: each iteration risks optimizing for reviewer preferences rather than original intent. IAQI solves this through anchors—semantic checksums verified after every change.

<iaqi_philosophy>
## Philosophy: The Anchor System

Before iterating, define anchors at three levels:

| Layer | Purpose | Can Change? | Example |
|-------|---------|-------------|---------|
| **Immutable** | Core identity phrases | Never | "Skills encode judgment. References encode facts." |
| **Semantic** | Meaning to preserve | Wording only | "Force intentional choices" (can rephrase, not remove) |
| **Structural** | Organization patterns | Flexible | 7-section template (order can change, sections preserved) |

**Why anchors matter**: Without them, iteration 5 optimizes for reviewer 5's preferences, not iteration 0's intent. Anchors are checksums against drift.

A good anchor set has:
- 3-5 immutable phrases (exact strings that must appear verbatim)
- 4-6 semantic anchors (meanings that must be preserved)
- 3-5 structural anchors (patterns/organization to maintain)
- A list of forbidden changes (what would violate the intent)
</iaqi_philosophy>

<iaqi_workflow>
## Workflow: 4-Phase Structure

Parse arguments from invocation:
- `artifact-path` (required): file to improve
- `--reviewers N` (default: 5): parallel reviewer count
- `--target X.X` (default: 9.0): score threshold for success
- `--max-iterations N` (default: 7): iteration limit

### Phase 1: UNDERSTAND (human required)

1. Read the artifact thoroughly
2. Propose an intent statement (1-2 sentences: why this artifact exists, its distinctive quality)
3. Create a workflow diagram showing the artifact's structure or flow:
   - Skills: phase/step workflow
   - Commands: decision tree or execution flow
   - Agents: interaction pattern
   - Prompts: section structure
4. Present to human via AskUserQuestion:
   - Show intent statement and diagram
   - Options: "Yes, proceed to anchoring" / "No, let me clarify"
5. If clarification needed, incorporate feedback and re-present
6. **Exit**: Understanding locked

### Phase 2: ANCHOR (human required)

1. Based on Phase 1 understanding, propose:
   - **Immutable anchors** (3-5): Exact phrases that capture the artifact's distinctive voice. These must appear verbatim in every iteration.
   - **Semantic anchors** (4-6): Core concepts that define what the artifact is about. Wording can change, meaning cannot.
   - **Structural anchors** (3-5): Organization patterns that serve a purpose (section types, flow patterns).
   - **Forbidden changes**: What modifications would violate the artifact's intent.
2. Present to human via AskUserQuestion:
   - Show all anchor categories
   - Options: "Approved as-is" / "Let me edit these"
3. If edits needed, incorporate and re-present
4. **Exit**: Anchors locked, write to state file

### Phase 3: SCORING SYSTEM (human required)

1. Detect artifact type: skill / command / prompt / agent / doc
2. Select dimension template from `<iaqi_dimensions>` based on type
3. Propose:
   - Dimensions with descriptions (from template, customizable)
   - Target score (default 9.0)
   - Non-negotiable dimension (must meet threshold even if overall passes)
4. Present to human via AskUserQuestion:
   - Show dimensions table, target, non-negotiable
   - Options: "Approved" / "Customize dimensions" / "Change target"
5. If customization needed, incorporate and re-present
6. **Exit**: Rubric locked, write to state file

### Phase 4: ITERATE (autonomous)

Run the iteration loop until exit condition:

```
iteration = 0

LOOP:
  iteration += 1

  IF iteration > max_iterations:
    HALT("Max iterations reached")
    Write final report to state file
    EXIT

  # 1. Spawn reviewers (parallel)
  Spawn N Task agents in a SINGLE message (parallel execution):
    - subagent_type: "general-purpose"
    - model: opus (or configured)
    - prompt: reviewer template with filled variables

  Wait for all reviewers to complete.

  # 2. Aggregate scores
  Calculate average per dimension
  Calculate overall average
  Check all immutable anchors present (unanimous agreement)

  # 3. Check exit conditions
  IF average >= target AND all_anchors_present:
    Write SUCCESS to state file
    Report final artifact with improvement summary
    EXIT SUCCESS

  IF any_anchor_missing:
    HALT("Anchor violation detected")
    Use AskUserQuestion: "Anchor '[phrase]' is missing. Options:"
      - "Revert last fix and continue"
      - "Update anchor (it was wrong)"
      - "Stop iteration"
    Handle response accordingly

  IF score_plateau (3 iterations with < 0.1 improvement):
    HALT("Diminishing returns - scores plateaued")
    Write report to state file
    EXIT

  # 4. Apply fixes
  Collect top fixes from each reviewer
  Prioritize by:
    1. Anchor safety (never break immutable anchors)
    2. Non-negotiable dimension improvement
    3. Lowest scoring dimension
  Apply fixes using Edit tool
  Follow <iaqi_fix_principles>

  # 5. Verify anchors
  Check all immutable anchors still present after edits
  IF any anchor lost:
    Revert the problematic edit
    Try alternative fix approach

  # 6. Update state file
  Write iteration details (scores, fixes, anchor status)

  GOTO LOOP
```
</iaqi_workflow>

<iaqi_reviewer_template>
## Reviewer Agent Template

Use this template when spawning reviewer agents. Fill variables before spawning.

```
You are an IAQI reviewer. Score an artifact against a rubric while verifying anchor preservation.

## Artifact
Read: $ARTIFACT_PATH

## Context
This artifact's intent: $INTENT_STATEMENT

## Immutable Anchors (must appear verbatim)
$IMMUTABLE_ANCHORS

## Scoring Dimensions
$DIMENSIONS_TABLE

Score each dimension 1-10 based on its description.

## Output Format (exactly)

### Scores
| Dimension | Score | Notes |
|-----------|-------|-------|
$DIMENSION_ROWS
| **OVERALL** | **X.X** | |

### Anchor Check
| Anchor | Present? |
|--------|----------|
$ANCHOR_ROWS

### Verdict
**PASS/FAIL** (target: $TARGET_SCORE, all anchors must be present)

### If FAIL: Top Fix
**Issue**: [most critical problem affecting score]
**Location**: [file:line or section name]
**Suggested fix**: [specific improvement, preserving intent]
```
</iaqi_reviewer_template>

<iaqi_dimensions>
## Dimension Templates by Artifact Type

Select the appropriate template based on artifact type. Human can customize during Phase 3.

### Skills

| Dimension | Description |
|-----------|-------------|
| Clarity | Instructions unambiguous? Followable without guessing? |
| Trigger Quality | Keywords specific? Activates correctly? NOT-for disambiguation? |
| Anti-Slop Power | Pushes away from generic output? Opinionated? Distinctive? |
| Structure | Well-organized? Proper semantic tags? Logical flow? |
| Composability | Integrates with other skills/commands? Handles dependencies? |
| Completeness | Everything needed to execute? No gaps? |
| Best Practices | Claude 4 positive framing? Explicit instructions? Good examples? |

### Commands

| Dimension | Description |
|-----------|-------------|
| Clarity | Steps clear? No ambiguous instructions? |
| Argument Design | Hints helpful? Defaults sensible? Required vs optional clear? |
| Error Handling | Failure cases addressed? Graceful degradation? |
| Tool Usage | Correct tools specified? Appropriate permissions? |
| Output Quality | Results actionable? Format appropriate for context? |
| Best Practices | Claude 4 conventions? Positive framing? |

### Prompts

| Dimension | Description |
|-----------|-------------|
| Clarity | Intent clear? No ambiguity in request? |
| Specificity | Concrete enough to act on? Measurable outcomes? |
| Tone | Appropriate voice? No condescending words? |
| Structure | Well-organized? Right length for purpose? |
| Best Practices | Positive framing? Examples where needed? Explicit constraints? |

### Agents

| Dimension | Description |
|-----------|-------------|
| Context Clarity | Stateless awareness explained? Role clear? |
| Responsibilities | Clear scope? Actionable tasks? Boundaries defined? |
| Constraints | What NOT to do explicit? Guardrails clear? |
| Return Format | Output structure specified? All required fields documented? |
| Tool Usage | Correct tools? Appropriate permissions? |
| Best Practices | Claude 4 patterns? Context efficiency? |

### Documentation

| Dimension | Description |
|-----------|-------------|
| Accuracy | Technically correct? Up to date with code? |
| Clarity | Understandable? Jargon defined? |
| Completeness | All necessary info? No critical gaps? |
| Structure | Well-organized? Easy to navigate? |
| Examples | Concrete? Copy-pasteable? Cover common cases? |
</iaqi_dimensions>

<iaqi_state_file>
## State File

**Location**: `<artifact-dir>/.iaqi/<artifact-name>-<YYYY-MM-DD>.md`

Create the `.iaqi/` directory if it doesn't exist. Write state after each phase completes.

### Template

```markdown
# IAQI State: [artifact-name]

**Date**: YYYY-MM-DD
**Artifact**: [full-path]
**Target Score**: X.X/10
**Max Iterations**: N
**Reviewers**: N
**Status**: in_progress | completed | halted

---

## Phase 1: Understanding

### Intent Statement
> "[1-2 sentences: why this artifact exists, its distinctive quality]"

### Workflow Diagram
```
[ASCII or Mermaid diagram]
```

**Status**: LOCKED

---

## Phase 2: Anchors

### Immutable Anchors (must appear verbatim)
1. "[exact phrase 1]"
2. "[exact phrase 2]"
...

### Semantic Anchors (meaning preserved)
| Concept | Meaning |
|---------|---------|
| [name] | [what it means] |
...

### Structural Anchors (organization preserved)
1. [pattern 1]
2. [pattern 2]
...

### Forbidden Changes
- [what would violate intent]
...

**Status**: LOCKED

---

## Phase 3: Scoring System

### Artifact Type
[skill | command | prompt | agent | doc]

### Dimensions
| Dimension | Description |
|-----------|-------------|
| [dim1] | [desc] |
...

### Target Score
X.X/10

### Non-Negotiable Dimension
[dimension] >= Y.Y

**Status**: LOCKED

---

## Phase 4: Iteration History

| Iter | Score | Delta | Anchors | Status |
|------|-------|-------|---------|--------|
| 0 | X.X | - | OK | baseline |
| 1 | X.X | +X.X | OK | continue |
...

### Iteration N Details

**Scores**:
| Reviewer | D1 | D2 | ... | Overall |
|----------|----|----|-----|---------|
| R1 | X | X | ... | X.X |
...
| **Avg** | X | X | ... | **X.X** |

**Anchor Check**: All present / VIOLATION: [details]

**Fixes Applied**:
1. [fix] - [rationale]
...

---

## Outcome

**Result**: SUCCESS | HALTED | IN_PROGRESS
**Final Score**: X.X/10
**Total Iterations**: N
**Anchors Preserved**: YES | [violations]
```
</iaqi_state_file>

<iaqi_fix_principles>
## Fix Application Principles

When applying fixes during iteration, follow these principles:

### From audit-prompt: Best Practices Dimension
The "Best Practices" dimension checks Claude 4 conventions:
- Positive framing (what TO DO, not just what to avoid)
- Explicit instructions (no ambiguity)
- XML semantic tags for structure
- Concrete examples where helpful
- Appropriate length (not over-explained)

### From prompt-coach: Intent Preservation
When rewriting any passage:
- **Preserve exact meaning**: You're improving expression, not changing ideas
- **Same content, said better**: Clearer, more precise, same length or shorter
- **Avoid condescending words**: Never use "just", "simply", "obviously", "clearly", "easy"
- **Use I-statements in feedback sections**: "I find..." not "You should..."
- **Be specific**: "Extract functions over 20 lines" not "Write clean code"

### Fix Prioritization
1. **Anchor safety first**: Never break an immutable anchor to fix something else
2. **Non-negotiable dimension**: If one dimension must meet threshold, prioritize it
3. **Lowest score**: After safety, address the weakest dimension
4. **Reviewer consensus**: If multiple reviewers flag the same issue, prioritize it

### Anti-Patterns
- **Over-fixing**: Don't rewrite passages that aren't broken
- **Scope creep**: Don't add new features while fixing quality
- **Voice drift**: Fixes should sound like the original author, not a committee
- **Anchor erosion**: Small "improvements" to immutable phrases are still violations
</iaqi_fix_principles>

<iaqi_success_criteria>
## Success Criteria

Your IAQI run succeeded when:

1. **Target Met**: Average score >= threshold
2. **Anchors Preserved**: All immutable phrases present verbatim
3. **Semantic Integrity**: All meanings preserved (wording may differ)
4. **Non-Negotiable Held**: Critical dimension didn't drop below threshold
5. **Efficient**: Reached target within max iterations

Signs of a quality IAQI run:
- Monotonic score improvement (no backsliding)
- Each iteration has clear rationale
- Final artifact reads like original author, not committee
- State file documents the journey
</iaqi_success_criteria>

<iaqi_closing>
## Closing Principle

The goal of IAQI is not perfection—it's preserving intent while improving execution. If your final artifact scores 9.5 but doesn't sound like the original author, you've failed. Anchors exist to keep the soul intact while polishing the surface.
</iaqi_closing>
