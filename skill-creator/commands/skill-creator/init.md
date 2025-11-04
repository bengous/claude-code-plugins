---
description: Initialize a new skill
argument-hint: <name> [--path <dir>]
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
model: claude-sonnet-4-5
---

# Initialize New Skill

Create a new skill with proper structure and template files.

## Usage

```
/skill-creator:init <skill-name> [--path <directory>]
```

## Arguments

- `<skill-name>`: Name of the skill to create (required)
- `--path <directory>`: Directory where the skill should be created (optional, defaults to current directory)

## What It Creates

The initialization script creates:
- `SKILL.md` - Main skill prompt file with template
- Proper directory structure
- Example reference files (optional)

## Your Task

Execute the skill initialization script:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/init_skill.py" $ARGUMENTS
```

After initialization, inform the user about the created files and next steps.
