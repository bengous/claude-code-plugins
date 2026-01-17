---
name: excellence-skill-creator
description: Create opinionated, anti-slop skills that encode taste and push Claude toward high-quality output. Use this skill when writing skills like frontend-design, cli-design, or system-architecture—skills that define what good looks like in a domain. Triggers: "create a skill for [domain]", "anti-slop skill", "opinionated skill", "skill like frontend-design". Not for general skill structure (use skill-creator for that).
---

This skill guides creation of design-excellence skills—skills that transform Claude from a generic pattern-matcher into an opinionated craftsperson for a specific domain.

The user provides: a domain (e.g., "API design", "error messages", "database schemas") and optionally context about what makes generic output unacceptable in that domain.

<excellence_philosophy>
## Philosophy: What Makes a Design-Excellence Skill

Design-excellence skills share five traits:

1. **Force intentional choices**: Generic output is the enemy. The skill makes Claude commit to a direction before implementation.

2. **Encode taste, not just rules**: Rules tell you what's legal. Taste tells you what's good. A design-excellence skill transmits the judgment of a senior practitioner.

3. **Name the anti-patterns**: Claude knows many patterns. Tell it which ones are tired, overused, or context-inappropriate. The NEVER block is often the most valuable part.

4. **Define done**: Success criteria prevent the "good enough" trap. Measurable outcomes distinguish excellent from adequate.

5. **Match complexity to context**: A TODO app doesn't need microservices. A landing page doesn't need a design system. Guide appropriate scaling.

The best design-excellence skills read like they were written by a senior practitioner with strong opinions—because they encode those opinions explicitly.
</excellence_philosophy>

<excellence_structure>
## Skill Structure Template

Every design-excellence skill contains these sections:

### 1. Opening Context (3-5 sentences)

What does the user provide? What will the skill produce? Set expectations.

```markdown
---
name: [domain]-design
description: [One sentence on what it creates]. Use this skill when [trigger conditions]. [What it avoids].
---

This skill guides creation of [domain output] that [quality statement].

The user provides [input type]. They may include [optional context].
```

### 2. Design Thinking Section

Questions the implementer MUST answer before implementation. Forces intentionality.

```markdown
<[domain]_design_thinking>
## Design Thinking

Before [implementing/designing/coding], understand the context:

- **[Key question 1]**: [What this question reveals]
- **[Key question 2]**: [What this question reveals]
- **[Key question 3]**: [What this question reveals]
- **[Key question 4]**: [What this question reveals]

[CRITICAL statement about the core principle]

Then implement [output] that is:
- [Quality 1]
- [Quality 2]
- [Quality 3]
- [Quality 4]
</[domain]_design_thinking>
```

### 3. Domain Guidelines

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

### 4. Anti-Patterns Block

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

### 5. Success Criteria

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

### 6. Complexity Matching

Guidance on scaling the solution appropriately.

```markdown
<[domain]_complexity>
## Match Complexity to Scope

[Simple case description] needs [simple approach].

[Complex case description] needs [richer approach].

[Guidance on what NOT to add to simple cases]
</[domain]_complexity>
```

### 7. Closing Principle

One memorable sentence that captures the skill's spirit.

```markdown
The best [outputs] feel like they were [created by X with Y characteristic]. [Instruction to channel that energy].
```
</excellence_structure>

<excellence_examples>
## Example Domains and Anti-Slop Angles

When creating a design-excellence skill, identify:
- **The domain**: What is being designed?
- **The anti-slop angle**: What does generic AI output look like? What makes practitioners cringe?

| Domain | Generic AI Output | Design Excellence |
|--------|-------------------|-------------------|
| API design | RESTful CRUD with every HTTP verb | Consistent resource modeling, clear error contracts, thoughtful pagination |
| Error messages | "An error occurred" | Context, cause, recovery path, actionable guidance |
| Config files | Every option exposed as a flag | Sensible defaults, progressive disclosure, environment-specific overrides |
| Test suites | 100% coverage with mocks everywhere | Behavior testing, realistic fixtures, minimal mocking |
| Logging | Printf debugging and wall-of-text | Structured logs, correlation IDs, appropriate levels, actionable alerts |
| Database schemas | Fully normalized, no indexes | Query-driven design, appropriate denormalization, considered access patterns |
| Documentation | Auto-generated from code | Task-oriented, examples-first, explains the "why" |
| Commit messages | "Fixed bug" / "Updated files" | Context, motivation, what changed and why |
</excellence_examples>

<excellence_writing_tips>
## Writing Tips

**Length**: 150-250 lines. Long enough to encode taste, short enough to stay in context.

**Semantic tags**: Use XML-style tags (`<domain_guidelines>`) for each major section. Helps Claude's attention and makes sections navigable.

**Examples over explanation**: A good/bad example pair teaches more than a paragraph of prose. Show, don't tell.

**Specificity**: "Avoid overengineering" is useless. "Don't add a plugin system to a grep replacement" is actionable.

**Voice**: Write as the senior practitioner mentoring a capable junior. Confident, opinionated, helpful. No hedging.

**Avoid**:
- Meta-commentary ("This skill helps you...")
- Hedging ("Consider maybe...", "You might want to...")
- Generic advice that applies everywhere ("Write clean code", "Follow best practices")
- Placeholder text ("Insert example here")

**Test your anti-patterns**: If you can't name 5+ specific anti-patterns Claude tends toward in this domain, you don't know the domain well enough yet.
</excellence_writing_tips>

<excellence_process>
## Creation Process

1. **Identify the domain** and its anti-slop angle. What does generic AI output look like here?

2. **Draft design thinking questions**. What must be decided before implementation?

3. **List 3-5 key guidelines** with concrete good/bad examples for each.

4. **Name 5-10 anti-patterns** Claude tends toward in this domain. Be specific.

5. **Define 4-6 success criteria** that distinguish excellent from adequate.

6. **Add complexity guidance** for scaling up/down appropriately.

7. **Write the closing principle**. One memorable sentence.

8. **Test by using it**. Does it actually change Claude's output? If the skill could apply to any domain without changes, it's too generic—push further.
</excellence_process>

Design-excellence skills are opinionated by design. If your skill reads like documentation, it's not a skill—it's a reference. Skills encode judgment. References encode facts. Know the difference.
