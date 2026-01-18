# Design-Excellence Skill Structure Template

This document contains detailed markdown templates for each section of a design-excellence skill.

## 1. Opening Context (3-5 sentences)

What does the user provide? What will the skill produce? Set expectations.

```markdown
---
name: [domain]-design
description: [One sentence on what it creates]. Use this skill when [trigger conditions]. [What it avoids].
---

This skill guides creation of [domain output] that [quality statement].

The user provides [input type]. They may include [optional context].
```

## 2. Design Thinking Section

Questions the implementer MUST answer before implementation. Forces intentionality.

```markdown
<[domain]_design_thinking>
## Design Thinking

Before [implementing/designing/coding], understand the context:

- **[Key question 1]**: [What this question reveals]
- **[Key question 2]**: [What this question reveals]
- **[Key question 3]**: [What this question reveals]
- **[Key question 4]**: [What this question reveals]

[Core principle that anchors the design philosophy]

Then implement [output] that is:
- [Quality 1]
- [Quality 2]
- [Quality 3]
- [Quality 4]
</[domain]_design_thinking>
```

## 3. Domain Guidelines

The "what to do" section. Use `<example_good>` and `<example_bad>` patterns.

```markdown
<[domain]_guidelines>
## [Domain] Guidelines

### [Aspect 1]
[Principle explanation]

<example_good title="[Descriptive title]">
[Good example with context]
</example_good>

<example_bad title="[Descriptive title]">
[Bad example - what to avoid]
</example_bad>

### [Aspect 2]
[Continue pattern...]
</[domain]_guidelines>
```

## 4. Anti-Patterns Block

Explicit list of what NOT to do. Name the patterns Claude tends toward.

```markdown
<[domain]_anti_patterns>
## Patterns to Avoid

Avoid [category 1]:
- [Specific anti-pattern] → Instead: [better approach]
- [Specific anti-pattern] → Instead: [better approach]

Avoid [category 2]:
- [Specific anti-pattern] → Instead: [better approach]
- [Specific anti-pattern] → Instead: [better approach]
</[domain]_anti_patterns>
```

## 5. Success Criteria

Measurable outcomes that define "done right."

```markdown
<[domain]_success_criteria>
## Success Criteria

Your [output] is well-designed when:

1. **[Criterion name]**: [Measurable/observable statement]
2. **[Criterion name]**: [Measurable/observable statement]
3. **[Criterion name]**: [Measurable/observable statement]
4. **[Criterion name]**: [Measurable/observable statement]
</[domain]_success_criteria>
```

## 6. Complexity Matching

Guidance on scaling the solution appropriately.

```markdown
<[domain]_complexity>
## Match Complexity to Scope

[Simple case description] needs [simple approach].

[Complex case description] needs [richer approach].

[Guidance on what NOT to add to simple cases]
</[domain]_complexity>
```

## 7. Closing Principle

One memorable sentence that captures the skill's spirit.

```markdown
The best [outputs] feel like they were [created by X with Y characteristic]. [Instruction to channel that energy].
```
