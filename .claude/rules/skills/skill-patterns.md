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

## Concrete Example

```markdown
---
name: api-testing
description: |
  Tests API endpoints with curl and validates responses.
  Use when you need to verify API behavior or debug endpoints.
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
---

# API Testing Skill

<context>
This skill provides systematic API endpoint testing. Use it when
implementing or debugging REST APIs to verify correct behavior.
</context>

<constraints>
- Only test endpoints on localhost or explicitly approved hosts
- Do NOT send credentials in plain text logs
- Limit to 10 requests per test run
</constraints>

<workflow>
## Step 1: Identify Endpoints
Read route definitions to find testable endpoints.

## Step 2: Construct Test Cases
For each endpoint, create curl commands testing:
- Happy path with valid input
- Error cases with invalid input
- Edge cases (empty, null, overflow)

## Step 3: Execute and Report
Run tests, capture responses, report pass/fail with details.
</workflow>
```

## Reference Implementation

See `orchestration/skills/layer-testing/SKILL.md` for a production example.
