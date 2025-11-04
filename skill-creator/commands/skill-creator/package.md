---
description: Package a skill for distribution
argument-hint: <path> [--output <dir>]
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/package_skill.py":*)
  - Read(*:*)
model: claude-sonnet-4-5
---

# Package Skill for Distribution

Package a skill into a distributable format.

## Usage

```
/skill-creator:package <path> [--output <directory>]
```

## Arguments

- `<path>`: Path to the skill directory to package (required)
- `--output <directory>`: Output directory for the packaged skill (optional, defaults to current directory)

## What It Does

The packaging script:
- Validates the skill structure
- Creates a distributable archive
- Includes all necessary files (SKILL.md, references, etc.)
- Generates metadata
- Optionally signs the package

## Your Task

Execute the skill packaging script:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/package_skill.py" $ARGUMENTS
```

Inform the user about the packaged file location and next steps for distribution.
