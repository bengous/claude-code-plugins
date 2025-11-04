# Skill Creator Plugin

A comprehensive guide and toolkit for creating effective Claude Code skills.

## Overview

This plugin provides both a complete skill creation guide and practical utilities for skill development. It helps you create, validate, and package high-quality skills for Claude Code.

## Features

- **Complete Creation Guide**: Best practices, patterns, and conventions (see SKILL.md)
- **Reference Documentation**: Output patterns and workflow examples
- **Initialization Tool**: Quickly scaffold new skills with proper structure
- **Validation Tool**: Check skills for common issues and required structure
- **Packaging Tool**: Prepare skills for distribution

## Commands

### `/skill-creator`

Load the full skill creation guide. This invokes the skill-creator skill, which provides comprehensive documentation on creating effective skills.

**Usage:**
```
/skill-creator
```

### `/skill-creator:init <name> [--path <dir>]`

Initialize a new skill with proper structure and template files.

**Arguments:**
- `<name>`: Name of the skill to create (required)
- `--path <dir>`: Directory where the skill should be created (optional)

**Example:**
```
/skill-creator:init my-analyzer --path ~/skills
```

### `/skill-creator:validate <path>`

Validate a skill's structure and check for common issues.

**Arguments:**
- `<path>`: Path to the skill directory (required)

**Example:**
```
/skill-creator:validate ~/skills/my-analyzer
```

### `/skill-creator:package <path> [--output <dir>]`

Package a skill for distribution.

**Arguments:**
- `<path>`: Path to the skill directory (required)
- `--output <dir>`: Output directory for the package (optional)

**Example:**
```
/skill-creator:package ~/skills/my-analyzer --output ~/dist
```

## Documentation

### SKILL.md

The main skill creation guide includes:
- Skill structure and conventions
- Best practices for skill design
- Output patterns and formatting
- Workflow examples
- Quality guidelines
- Common pitfalls and how to avoid them

Access it via `/skill-creator` command or read the file directly.

### references/

Additional reference documentation:
- `output-patterns.md`: Standardized output formats
- `workflows.md`: Common skill workflow patterns

## Installation

This plugin is part of the bengolea-plugins marketplace:

```bash
/plugin marketplace add bengolea/claude-plugins
/plugin install skill-creator@bengolea-plugins
```

For local development:
1. Clone this repository
2. Open Claude Code from the repository root
3. Commands are automatically available

## Requirements

- Python 3.6+ (for utility scripts)
- Claude Code

## License

Apache License 2.0 - See LICENSE file for details

## Author

Anthropic (support@anthropic.com)

## Contributing

This is a reference plugin demonstrating skill creation best practices. Feel free to use it as a template for your own skill development workflows.
