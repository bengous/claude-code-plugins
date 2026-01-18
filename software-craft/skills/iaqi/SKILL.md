---
name: iaqi
description: Iteratively improve prompts/skills to target score via parallel reviewer agents. NOT for: one-shot edits, simple fixes, tasks without measurable quality. USE for: skills, prompts, or documents needing iterative refinement with score targets. Triggers: "iterate to 9.0", "quality loop", "IAQI", "reviewer loop", "improve until threshold", "iterative quality".
---

Intent-Anchored Quality Iteration (IAQI) prevents semantic drift during iterative improvement. The problem with naive iteration: each fix optimizes for reviewer preferences rather than original intent. IAQI solves this through anchors.

<iaqi_philosophy>
## Philosophy: The Three-Layer Anchor System

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
## Workflow: The Iteration Loop

### Step 0: Define Golden Reference

Before any iteration, capture:

```markdown
## Golden Reference

### Meta-Anchor
> "[One sentence capturing why this artifact exists]"

### Immutable Anchors (must appear verbatim)
1. "[exact phrase 1]"
2. "[exact phrase 2]"
...

### Semantic Anchors (meaning preserved)
1. **[Concept]** - [What it means]
...

### Structural Anchors (organization preserved)
1. [Pattern/structure to maintain]
...

### Forbidden Changes
- [What would violate intent]
...

### Target Score
- Overall: X.X/10
- Non-negotiable dimension: [e.g., Anti-Slop Power ≥ 9.0]
```

### Step 1: Pre-Check Anchors

Before making changes:
- [ ] All immutable anchors present verbatim
- [ ] All semantic anchors present (meaning preserved)
- [ ] Critical dimension score ≥ previous iteration

### Step 2: Apply Fixes

Based on reviewer feedback, make targeted changes. After each change:
- Verify no immutable anchor was modified
- Check semantic anchors still present
- Document: `[change] - [rationale]`

### Step 3: Spawn Parallel Reviewers

Spawn N (typically 5) Opus agents with the reviewer prompt template. Run in parallel for speed.

### Step 4: Aggregate Scores

Collect scores, calculate averages:

```markdown
| Reviewer | D1 | D2 | D3 | D4 | D5 | D6 | D7 | Overall |
|----------|----|----|----|----|----|----|----|----|
| 1 | X | X | X | X | X | X | X | X.X |
...
| **Avg** | X | X | X | X | X | X | X | **X.X** |
```

### Step 5: Check Exit Conditions

**Success** (exit loop):
- Average score ≥ target
- All immutable anchors present
- Non-negotiable dimension ≥ threshold

**Continue** (loop to Step 2):
- Score below target
- Actionable feedback available

**Failure** (stop and consult human):
- Any immutable anchor removed
- Non-negotiable dimension decreased
- 5+ iterations without improvement
- Proposed change would alter core intent
</iaqi_workflow>

<iaqi_reviewer_template>
## Reviewer Prompt Template

Use this template for spawning reviewer agents:

```
Review [artifact name]. Score each dimension 1-10.

Read: [file path]

Dimensions:
- **Clarity**: Unambiguous? Followable?
- **Trigger Quality**: Good keywords? Activates correctly?
- **Anti-Slop Power**: Pushes away from generic? Opinionated?
- **Structure**: Well-organized? Proper tags? Flow?
- **Composability**: Integrates with other tools? Handles deps?
- **Completeness**: Everything needed? Gaps?
- **Best Practices**: Follows conventions? Positive framing?

Output exactly:
| Dimension | Score |
|-----------|-------|
| Clarity | X |
| Trigger Quality | X |
| Anti-Slop Power | X |
| Structure | X |
| Composability | X |
| Completeness | X |
| Best Practices | X |
| **OVERALL** | **X.X** |

PASS/FAIL: [PASS if all ≥ threshold, else FAIL]
If FAIL: [ONE most critical fix with line reference]
```

Customize dimensions for non-skill artifacts.
</iaqi_reviewer_template>

<iaqi_anti_patterns>
## Anti-Patterns

**Semantic Drift**
- Symptom: Iteration 5 looks nothing like iteration 0
- Cause: Optimizing for reviewer preferences, not original intent
- Fix: Check anchors after every change

**Over-Iteration**
- Symptom: Scores plateau, changes become cosmetic
- Cause: Diminishing returns past threshold
- Fix: Exit at first iteration meeting target

**Anchor Violation**
- Symptom: Immutable phrase modified or removed
- Cause: "Improving" language without checking anchors
- Fix: Revert immediately, re-read golden reference

**Reviewer Fatigue**
- Symptom: Later iterations score lower despite improvements
- Cause: Reviewers becoming stricter over time
- Fix: Use fresh agents each iteration

**Score Chasing**
- Symptom: Changes that game metrics but hurt quality
- Cause: Optimizing numbers over substance
- Fix: Non-negotiable dimension as anchor (e.g., Anti-Slop Power)
</iaqi_anti_patterns>

<iaqi_success_criteria>
## Success Criteria

Your IAQI run succeeded when:

1. **Target Met**: Average score ≥ threshold (typically 9.0)
2. **Anchors Preserved**: All immutable phrases present verbatim
3. **Semantic Integrity**: All meanings preserved (wording may differ)
4. **Non-Negotiable Held**: Critical dimension didn't decrease
5. **Efficient**: Reached target in ≤5 iterations

Signs of a quality IAQI run:
- Monotonic score improvement (no backsliding)
- Each iteration has clear rationale
- Final artifact reads like original author, not committee
</iaqi_success_criteria>

<iaqi_complexity>
## Match Complexity to Context

**Simple artifact** (single prompt, short doc):
- 2-3 immutable anchors
- 3 reviewers
- Target: 8.5/10
- Max iterations: 3

**Complex artifact** (skill, multi-section doc):
- 4-5 immutable anchors
- 5 reviewers
- Target: 9.0/10
- Max iterations: 5

**Critical artifact** (core system prompt, foundational skill):
- 5+ immutable anchors
- 5 Opus reviewers
- Target: 9.5/10
- Max iterations: 7
- Require human approval at iteration 3

Don't run IAQI on throwaway prompts. The overhead isn't worth it for one-shot tasks.
</iaqi_complexity>

<iaqi_closing>
## Closing Principle

The goal of IAQI is not perfection—it's preserving intent while improving execution. If your final artifact scores 9.5 but doesn't sound like the original author, you've failed. Anchors exist to keep the soul intact while polishing the surface.
</iaqi_closing>
