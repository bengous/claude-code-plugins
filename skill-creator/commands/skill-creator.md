---
description: Guide for creating effective Claude skills
allowed-tools:
  - Skill(*:*)
model: claude-sonnet-4-5
---

# Skill Creator

A comprehensive guide for creating effective Claude Code skills, with utilities for initialization, validation, and packaging.

## What This Skill Provides

- **Complete skill creation guide**: Best practices, patterns, and conventions
- **Reference documentation**: Output patterns and workflow examples
- **Utility commands**: Initialize, validate, and package skills

## Available Commands

- `/skill-creator` - Load the full skill creation guide (this command)
- `/skill-creator:init <name> [--path <dir>]` - Initialize a new skill
- `/skill-creator:validate <path>` - Validate skill structure
- `/skill-creator:package <path> [--output <dir>]` - Package a skill

## Your Task

Invoke the skill-creator skill to access the complete guide:

```
skill-creator:skill-creator
```

This will load SKILL.md which contains comprehensive documentation on:
- Skill creation best practices
- Structural conventions
- Output patterns
- Workflow examples
- Quality guidelines
