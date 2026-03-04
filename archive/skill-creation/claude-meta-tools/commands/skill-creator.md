---
description: Guide for creating effective Claude skills
allowed-tools:
  - Read(*:*)
model: claude-opus-4-5
---

# Skill Creator

A comprehensive guide for creating effective Claude Code skills, with utilities for initialization, validation, and packaging.

## What This Plugin Provides

- **Complete skill creation guide**: Best practices, patterns, and conventions
- **Reference documentation**: Output patterns and workflow examples
- **Utility commands**: Initialize, validate, and package skills

## Available Commands

- `/skill-creator` - Load the full skill creation guide (this command)
- `/skill-creator:init <name> [--path <dir>]` - Initialize a new skill
- `/skill-creator:validate <path>` - Validate skill structure
- `/skill-creator:package <path> [--output <dir>]` - Package a skill

## Your Task

Read and present the complete skill creation guide to the user:

```
Read the file: ${CLAUDE_PLUGIN_ROOT}/SKILL.md
```

This file contains comprehensive documentation on:
- Skill creation best practices
- Structural conventions
- Output patterns and formatting
- Workflow examples
- Quality guidelines
- Common pitfalls and how to avoid them

After reading SKILL.md, summarize the key sections and let the user know they can ask questions about any specific aspect of skill creation.
