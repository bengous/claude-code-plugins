---
paths:
  - "**/skills/**/*.md"
  - "**/SKILL.md"
---

# Skill Patterns

Skills are **reusable knowledge modules** that agents can invoke for specialized tasks.

## Skill Structure

Skills live in `skills/<skill-name>/SKILL.md`:

```markdown
---
name: my-skill
description: |
  Multi-line description of what this skill does.
  When agents should invoke it.
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
  - Grep(*:*)
---

# Skill Name

<context>
Why this skill exists and what problem it solves.
</context>

<constraints>
- Boundaries the skill enforces
- What it must NOT do
</constraints>

<workflow>
## Step 1: First Step
Instructions for this step.

## Step 2: Second Step
Instructions for this step.
</workflow>
```

## Skill Directory Structure

Complex skills can have supporting files:

```
skills/
└── layer-testing/
    ├── SKILL.md              # Main skill definition
    ├── references/           # Supporting documentation
    │   └── patterns.md
    └── templates/            # Reusable templates
        └── example.md
```

## Reference Implementation

See `orchestration/skills/layer-testing/SKILL.md` for a production example.
