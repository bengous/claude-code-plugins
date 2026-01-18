---
name: excellence-skill-creator
description: Create opinionated, anti-slop skills that encode taste. NOT for: general skill structure, reference guides, procedural docs (use skill-creator instead). USE for: frontend-design, cli-design, system-architecture style skills. Triggers: "anti-slop skill", "opinionated skill", "make Claude less generic", "skill like frontend-design", "design-excellence skill".
---

Design-excellence skills transform Claude from a generic pattern-matcher into an opinionated craftsperson. A skill without strong opinions is just documentation with delusions of grandeur.

The user provides a domain (e.g., "API design", "error messages", "database schemas") and context about what makes generic output unacceptable. If they can't articulate why generic output fails, help them find that angle first—it's the foundation of everything that follows.

<excellence_philosophy>
## Philosophy: What Makes a Design-Excellence Skill

A design-excellence skill without these five traits is just documentation pretending to have opinions:

1. **Force intentional choices**: Make Claude commit to a direction before touching the keyboard. Intentional choices produce distinctive output; default choices produce forgettable output.

2. **Encode taste, not just rules**: Rules tell you what's legal. Taste tells you what's *good*. Your skill transmits the judgment of someone who has failed enough times to know what actually matters.

3. **Name the anti-patterns**: Claude knows thousands of patterns. Tell it which ones are tired, overused, or inappropriate for this context. The anti-patterns block is often the most valuable section—it's where your hard-won experience becomes actionable guidance.

4. **Define done**: Success criteria prevent the "good enough" trap. If you can't measure it, Claude will satisfice. Measurable outcomes distinguish excellent from adequate.

5. **Match complexity to context**: A TODO app doesn't need microservices. A landing page doesn't need a design system. A skill that over-engineers simple cases teaches Claude to over-engineer everything.

If your skill reads like it could have been written by anyone, it will produce output that could have been written by anyone. Encode your opinions explicitly.
</excellence_philosophy>

<excellence_workflow>
## Workflow: Scaffold → Craft → Audit

This skill orchestrates a 3-pass workflow for maximum skill quality.

### Step 0: Choose Workflow

Ask the user which workflow fits their situation:

| Option | When to Use |
|--------|-------------|
| **Full workflow** (default) | Creating a new skill from scratch |
| **Craft + Audit** | SKILL.md structure exists, need content |
| **Craft only** | Quick iteration, skip validation |

Default: Full workflow. If SKILL.md already exists, start with Craft.

### Pass 1: Scaffold

**When to run**: New skill from scratch. Skip if SKILL.md exists.

Invoke skill-creator init with the domain name. If unavailable, create manually:

```yaml
---
name: [domain]-design
description: [What it creates]. NOT for: [exclusions]. USE for: [use cases]. Triggers: [5-7 specific phrases].
---
```

The description format matters: state what it does, what it's NOT for (disambiguation), what it IS for, and specific trigger phrases.

### Pass 2: Craft

**When to run**: Always.

Execute these steps in order:

1. Identify the domain and its anti-slop angle
2. Draft 4-5 design thinking questions that force real decisions
3. Write 3-5 guidelines with good/bad example pairs
4. Name 5-10 specific anti-patterns Claude tends toward in this domain
5. Define 4-6 measurable success criteria
6. Add complexity matching guidance (what simple cases need vs complex)
7. Write a closing principle—one memorable sentence
8. Use the templates in `<excellence_structure>` as scaffolding

This is the core pass. It transforms structure into opinionated content.

### Pass 3: Audit

**When to run**: Recommended. Skip only for quick iterations.

Invoke the audit-prompt skill on the completed SKILL.md. It checks against Claude 4 best practices and suggests fixes.

If audit-prompt isn't available, manually verify:
- Triggers are specific (not just "create a skill")
- Examples show concrete good/bad contrast
- Each guideline explains "why" not just "what"
- Anti-patterns name specific behaviors, not vague categories

### Workflow Complete

After all passes, present:
- Summary of what was created
- Path to the skill file
- Suggestion to test by invoking the skill
</excellence_workflow>

<excellence_structure>
## Skill Structure Template

Every design-excellence skill contains seven sections:

**Frontmatter format**: `description: [What]. NOT for: [exclusions]. USE for: [use cases]. Triggers: [phrases].`

1. **Opening Context** - What user provides, what skill produces
2. **Design Thinking** - Questions that force intentionality before implementation
3. **Domain Guidelines** - "What to do" with good/bad example pairs
4. **Anti-Patterns Block** - Explicit patterns to avoid with alternatives
5. **Success Criteria** - Measurable outcomes defining "done right"
6. **Complexity Matching** - Guidance on scaling appropriately
7. **Closing Principle** - One memorable sentence capturing the skill's spirit

For detailed templates with markdown examples, see:
`references/structure-template.md`
</excellence_structure>

<excellence_examples>
## Example Domains and Anti-Slop Angles

When creating a design-excellence skill, identify:
- **The domain**: What is being designed?
- **The anti-slop angle**: What does generic AI output look like? What makes practitioners cringe?

The table below shows the contrast for common domains:

<example_good title="Strong anti-slop contrast">
| Domain | Generic | Excellence |
|--------|---------|------------|
| Error messages | "An error occurred" | Context + cause + recovery path |
| API design | Every HTTP verb for CRUD | Consistent resources, clear error contracts |
</example_good>

<example_bad title="Weak anti-slop contrast">
| Domain | Generic | Excellence |
|--------|---------|------------|
| Code | Bad code | Good code |
| Design | Ugly design | Pretty design |
</example_bad>

**Full domain reference**:

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

<excellence_worked_example>
## Worked Example: Error Messages Skill

A condensed example showing the pattern in action (~60 lines, real skills should be 150-250):

```markdown
---
name: error-messages
description: Create helpful, actionable error messages that guide users to recovery. Use when building error handling, validation feedback, or failure responses. Triggers: "error message", "error handling", "user-friendly errors", "validation messages".
---

This skill guides creation of error messages that help users recover, not just inform them something broke.

<error_design_thinking>
## Design Thinking

Before writing error messages:
- **Audience**: Developer debugging? End user recovering? Both?
- **Context**: CLI stderr? API JSON? UI toast?
- **Recovery**: What can the user actually do about it?
- **Severity**: Fatal? Retryable? Warning?

Error messages are micro-documentation. Treat them with the same care.
</error_design_thinking>

<error_guidelines>
## Guidelines

### Always Include a Recovery Path

<example_good title="Actionable error">
Error: Cannot connect to database at localhost:5432

Possible causes:
- PostgreSQL is not running
- Wrong port (check DATABASE_URL)
- Firewall blocking connection

Try: pg_isready -h localhost -p 5432
Docs: https://docs.app.com/troubleshooting/db
</example_good>

<example_bad title="Dead-end error">
Error: Connection failed
</example_bad>

### Name the Specific Problem

<example_good title="Specific error">
Error: File 'config.yaml' not found in /app/config/

Expected location: /app/config/config.yaml
Current directory: /app/src/

Did you mean: /app/config/config.yml (found)
</example_good>

<example_bad title="Vague error">
Error: Invalid configuration
</example_bad>
</error_guidelines>

<error_anti_patterns>
## Patterns to Avoid

- "An error occurred" → Name the specific error and its cause
- Stack traces to end users → Log internally, show human message
- Error codes only → Include human-readable message first
- "Please try again" without context → Explain what to try differently
- "Contact support" as first option → Offer self-service recovery first
</error_anti_patterns>

<error_success_criteria>
## Success Criteria

1. **Self-diagnosable**: User can identify the cause without external help
2. **Actionable**: At least one concrete recovery step provided
3. **Contextual**: Error includes relevant state (paths, values, IDs)
4. **Appropriate**: Tone matches audience (dev vs end-user)
</error_success_criteria>

<error_complexity>
## Match Complexity to Scope

CLI script stderr: One-line message with cause. No docs links, no structured data.

User-facing API: Structured JSON with error code, human message, and documentation URL.

Internal service: Structured logs with correlation IDs, stack traces, request context.

Don't add recovery suggestions to internal errors that users never see. Don't strip context from user-facing errors to "keep it simple."
</error_complexity>
```

This example demonstrates all seven sections: frontmatter with triggers, design thinking, guidelines with example pairs, anti-patterns, success criteria, and complexity matching.
</excellence_worked_example>

<excellence_writing_tips>
## Writing Tips

**Length**: 150-250 lines. Long enough to encode taste, short enough to stay in context.

**Semantic tags**: Use XML-style tags (`<domain_guidelines>`) for each major section. Helps Claude's attention and makes sections navigable.

**Examples over explanation**: A good/bad example pair teaches more than a paragraph of prose. Show, don't tell.

**Specificity**: "Avoid overengineering" is useless. "Don't add a plugin system to a grep replacement" is actionable.

**Voice**: Write as the senior practitioner mentoring a capable junior. Confident, opinionated, helpful. No hedging.

**What to write instead**:

| Instead of | Write |
|------------|-------|
| Meta-commentary ("This skill helps you...") | Jump straight into domain guidance—Claude knows it's reading a skill |
| Hedging ("Consider maybe...") | Direct imperatives ("Use X", "Apply Y")—skills encode confident opinions |
| Generic advice ("Write clean code") | Domain-specific guidance ("Extract functions over 20 lines") |
| Placeholder text ("Insert example here") | Actual examples—Claude may use placeholders literally |

Write like a senior practitioner giving direct advice, not a textbook hedging its bets.

**Test your anti-patterns**: If you can't name 5+ specific anti-patterns Claude tends toward in this domain, you don't know the domain well enough yet.
</excellence_writing_tips>

<excellence_validation>
## Validating Your Skill

Test with at least 3 diverse prompts in the target domain:

1. **Invoke the skill** on a real task
2. **Compare output** against what Claude produces without the skill
3. **Check anti-patterns** - are they actually being avoided?
4. **Verify measurability** - can you objectively assess each success criterion?

If outputs are indistinguishable with/without the skill, your anti-patterns aren't specific enough.
</excellence_validation>

<excellence_iteration>
## When the Skill Isn't Working

Symptoms and fixes:

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| Output looks the same with/without skill | Anti-patterns too vague | Name specific behaviors, not categories. "Avoid bad error messages" → "Avoid 'An error occurred' without context, cause, or recovery path" |
| Claude ignores sections | Triggers not matching | Add more trigger phrases to description; check if skill is actually loading |
| Claude over-applies guidance | Complexity matching missing | Add explicit "don't do X for simple cases" guidance |
| Output feels mechanical | Design thinking questions too generic | Questions should force real decisions, not checkboxes |
| Anti-patterns aren't avoided | Too many anti-patterns | Prioritize 5-7 specific ones over 15 vague ones |

If you've iterated 3+ times without improvement, the domain may not benefit from an opinionated skill. Some domains genuinely have multiple valid approaches—consider a reference-style skill instead.
</excellence_iteration>

<excellence_closing>
## Closing Principle

The test is simple: if removing your skill produces identical output, you wrote documentation. If it produces noticeably worse output, you wrote a skill.

Skills encode judgment. References encode facts. Know the difference, and write accordingly.
</excellence_closing>
