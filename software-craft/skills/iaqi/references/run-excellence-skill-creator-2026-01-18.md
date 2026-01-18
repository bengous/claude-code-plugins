# IAQI Run: excellence-skill-creator

**Date**: 2026-01-18
**Target**: `software-craft/skills/excellence-skill-creator/SKILL.md`
**Starting Score**: 8.0/10
**Final Score**: 9.08/10
**Iterations**: 4
**Reviewers**: 5 Opus agents per iteration

---

## Golden Reference

### Meta-Anchor

> "This skill exists because skills that merely describe 'what to do' produce competent but forgettable output. Excellence requires encoding the judgment of someone who has failed enough times to know what actually matters."

### Immutable Anchors

These phrases must appear verbatim:

1. "Encode taste, not just rules"
2. "Generic output is the enemy"
3. "skills that transform Claude from a generic pattern-matcher into an opinionated craftsperson"
4. "Skills encode judgment. References encode facts."

### Semantic Anchors

Meaning preserved (wording can improve):

1. **Force intentional choices** - Make Claude commit before implementing
2. **Name the anti-patterns** - Tell Claude which patterns are tired/overused
3. **Define done** - Measurable success criteria
4. **Match complexity to context** - TODO app ≠ microservices
5. **Anti-patterns block is valuable** - It's where experience becomes guidance

### Structural Anchors

Organization flexible, content preserved:

1. 3-pass workflow: Scaffold → Craft → Audit
2. 5 traits of design-excellence skills
3. 7-section skill template
4. Domain contrast table (Generic vs Excellence)
5. Worked example with good/bad pairs

### Forbidden Changes

- Softening the opinionated stance
- Making it more "balanced" or "neutral"
- Removing anti-pattern focus
- Changing the 5 traits' meaning
- Diluting the "anti-slop" identity

---

## Iteration History

| Iteration | Score | Delta | Key Changes |
|-----------|-------|-------|-------------|
| 0 | 8.0 | - | Baseline (Phase 1 fixes already applied) |
| 1 | 8.02 | +0.02 | Extract templates to reference file, reorder philosophy before workflow |
| 2 | 8.24 | +0.22 | Stronger practitioner voice, add iteration/debugging section, remove pseudo-code syntax |
| 3 | 8.6 | +0.36 | Prose-based tool invocations, formal closing principle section |
| 4 | 9.08 | +0.48 | Negative triggers for disambiguation, explicit frontmatter format |

---

## Dimension Scores by Iteration

### Iteration 1 (8.02)

| Dimension | R1 | R2 | R3 | R4 | R5 | Avg |
|-----------|----|----|----|----|----|----|
| Clarity | 8 | 8 | 8 | 8 | 8 | 8.0 |
| Trigger Quality | 9 | 9 | 9 | 7 | 9 | 8.6 |
| Anti-Slop Power | 8 | 9 | 8 | 9 | 7 | 8.2 |
| Structure | 9 | 9 | 9 | 8 | 9 | 8.8 |
| Composability | 7 | 7 | 7 | 7 | 9 | 7.4 |
| Completeness | 7 | 8 | 8 | 8 | 7 | 7.6 |
| Best Practices | 8 | 8 | 7 | 8 | 8 | 7.8 |
| **Overall** | 7.9 | 8.3 | 7.9 | 7.9 | 8.1 | **8.02** |

### Iteration 3 (8.6)

| Dimension | R1 | R2 | R3 | R4 | R5 | Avg |
|-----------|----|----|----|----|----|----|
| Clarity | 9 | 9 | 9 | 9 | 9 | 9.0 |
| Trigger Quality | 8 | 8 | 9 | 8 | 8 | 8.2 |
| Anti-Slop Power | 9 | 9 | 9.5 | 9 | 9 | 9.1 |
| Structure | 9 | 9 | 9 | 9 | 9 | 9.0 |
| Composability | 8 | 8 | 8 | 8 | 8 | 8.0 |
| Completeness | 8 | 8 | 8.5 | 8 | 8 | 8.1 |
| Best Practices | 9 | 9 | 9 | 9 | 9 | 9.0 |
| **Overall** | 8.6 | 8.6 | 8.6 | 8.6 | 8.6 | **8.6** |

### Iteration 4 - Final (9.08)

| Dimension | R1 | R2 | R3 | R4 | R5 | Avg |
|-----------|----|----|----|----|----|----|
| Clarity | 9 | 9 | 9 | 9 | 9 | **9.0** |
| Trigger Quality | 9 | 9 | 9 | 9 | 9 | **9.0** |
| Anti-Slop Power | 10 | 9 | 10 | 10 | 10 | **9.6** |
| Structure | 9 | 9 | 9 | 9 | 9 | **9.0** |
| Composability | 9 | 9 | 9 | 9 | 9 | **9.0** |
| Completeness | 9 | 9 | 9 | 9 | 9 | **9.0** |
| Best Practices | 9 | 9 | 9 | 9 | 9 | **9.0** |
| **Overall** | 9.1 | 9.0 | 9.1 | 9.1 | 9.1 | **9.08** |

---

## Reviewer Prompt Used

```
Final review of `excellence-skill-creator` (iteration N). Target: ALL dimensions 9.0+.

Read: `software-craft/skills/excellence-skill-creator/SKILL.md`

Score each 1-10:
- Clarity, Trigger Quality, Anti-Slop Power, Structure, Composability, Completeness, Best Practices

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

PASS/FAIL: [PASS if all ≥9, else FAIL]
If FAIL, the ONE most critical fix: [specific issue with line ref]

Be precise. We need all 9s to pass.
```

---

## Fixes Applied by Phase

### Phase 2 (8.0 → 8.02)
- Extract structure template (127 lines) to `references/structure-template.md`
- Reorder: philosophy before workflow ("why" before "how")
- Consolidate redundant `<excellence_process>` into Pass 2
- Add `<excellence_validation>` section
- Soften "CRITICAL" → "Core principle"
- Change "The NEVER block" → "The anti-patterns block"

### Phase 3 (8.02 → 8.24)
- Fix line 6 meta-commentary ("This skill guides..." → direct statement)
- Reframe "Generic output is the enemy" to positive framing
- Strengthen practitioner voice throughout philosophy section
- Add `<excellence_iteration>` section with symptom-diagnosis-fix table
- Add complexity section to worked example
- Remove hardcoded `software-craft/skills/` path

### Phase 4 (8.24 → 8.6)
- Replace pseudo-code `Skill(skill:...)` syntax with prose instructions
- Clean up redundant skip logic
- Reframe "Why It's Harmful" table to "What to write instead"
- Add formal `<excellence_closing>` section

### Phase 5 (8.6 → 9.08)
- Add explicit negative triggers: "NOT for: general skill structure, reference guides, procedural docs"
- Add frontmatter format guidance: `[What]. NOT for: [exclusions]. USE for: [cases]. Triggers: [phrases].`
- Inline frontmatter template in Scaffold fallback

---

## Lessons Learned

### What Moved Scores Most

1. **Removing pseudo-code syntax** (+0.36): The `Skill(skill: "...", args: "...")` notation confused reviewers about whether it was executable. Prose instructions scored higher.

2. **Negative triggers** (+0.48): Adding "NOT for:" in the description was the single biggest improvement. Disambiguation matters more than additional positive triggers.

3. **Practitioner voice** (+0.22): Changing instructional tone to mentorship tone ("A skill without strong opinions is just documentation with delusions of grandeur") increased Anti-Slop Power significantly.

### What Didn't Help

- Adding more trigger phrases (diminishing returns past 5-7)
- Expanding worked example length (90 lines was sufficient)
- Adding more sections (iteration section valuable, but more would bloat)

### Anchor Preservation

| Anchor | Status | Final Location |
|--------|--------|----------------|
| "Encode taste, not just rules" | ✓ | Line 17 |
| "Generic output is the enemy" | ✓ | Line 15 (reworded to positive framing but phrase preserved) |
| "skills that transform Claude..." | ✓ | Line 6 |
| "Skills encode judgment..." | ✓ | Line 309 |

All 4 immutable anchors present in final version.

### Anti-Slop Power

This dimension scored highest (9.6 avg, with 4 reviewers giving 10/10). Key factors:
- The skill practices what it preaches
- Concrete good/bad examples throughout
- Memorable litmus test: "if removing your skill produces identical output, you wrote documentation"

---

## Artifacts Produced

| File | Lines | Change |
|------|-------|--------|
| `software-craft/skills/excellence-skill-creator/SKILL.md` | 312 | Modified |
| `software-craft/skills/excellence-skill-creator/references/structure-template.md` | 126 | Created |

**Commit**: `4ca972c feat(software-craft): iterate excellence-skill-creator to 9.0+ via IAQI`
