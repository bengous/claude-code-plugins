---
description: Validate skill structure
argument-hint: <path>
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
model: claude-opus-4-5
---

# Validate Skill Structure

Quickly validate that a skill has the required structure and files.

## Usage

```
/skill-creator:validate <path>
```

## Arguments

- `<path>`: Path to the skill directory to validate (required)

## What It Checks

The validation script checks for:
- Presence of SKILL.md
- Valid SKILL.md structure
- Required sections and frontmatter
- File permissions
- Common issues and mistakes

## Your Task

Execute the skill validation script:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/quick_validate.py" $ARGUMENTS
```

Report the validation results to the user. If there are issues, suggest how to fix them.
