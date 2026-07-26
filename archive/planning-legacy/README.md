# planning-legacy (archived)

Planning skills retired from active plugins because newer assets cover the same ground.

## Contents

```
skills/
  structured-plan/                  # checklist-driven planning workflow (was claude-meta-tools)
    SKILL.md
    references/task-template.md
    references/verification-agents.md
```

## Why archived

`structured-plan` was a 7-step checklist that drove plan drafting: research validation,
task breakdown, dependency mapping, completeness check, then a mandated post-implementation
verification task.

Archived for two reasons:

1. **Unused.** The owner does not reach for it. The consumer check at archival time found
   zero references anywhere in the repo — the only matches were self-references inside its
   own `SKILL.md`, so nothing needed rewiring.
2. **Superseded.** `claude-meta-tools/skills/thorough-plan/` covers the same need with an
   adaptive triage loop rather than a fixed checklist, and native plan mode plus
   `ExitPlanMode` now handle the approval step the skill's Step 7 described manually.

Its Step 6 also mandated injecting a "Post-Implementation Verification" task into every
plan. Current prompting guidance
(`claude-meta-tools/references/claude-prompting-guidance.md`) names that pattern directly:
explicit verification scaffolding causes over-verification on Opus-class models and costs
tokens with no quality gain. Fable-class models want the opposite, which is why the fix
would have required establishing a target model rather than a simple edit — another reason
retirement was cleaner than repair.

`references/verification-agents.md` is kept here rather than deleted: the three-reviewer
prompt set (Compliance / Best Practices / Code Simplifier) is still a reasonable pattern to
crib from when a long-run Fable-class workflow genuinely needs fresh-context verifiers.
