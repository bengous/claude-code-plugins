# External Reference Repositories

This directory contains external repositories cloned for reference. These are independent git repositories that are not tracked by the main dotfiles repo.

## Setup Instructions

After cloning your dotfiles on a new machine, run these commands to set up the external references:

```bash
cd /path/to/dotfiles/docs/claude/references/

# Clone the Anthropic Cookbook
git clone https://github.com/anthropics/anthropic-cookbook.git
```

## Available References

### 1. Anthropic Cookbook
- **Repository**: https://github.com/anthropics/anthropic-cookbook
- **Purpose**: Official examples, recipes, and patterns for working with Claude
- **Directory**: `anthropic-cookbook/`
- **Contents**:
  - Claude Code SDK examples
  - Tool use patterns and examples
  - Multimodal workflows
  - Extended thinking demonstrations
  - Fine-tuning guides
  - Observability patterns
  - Third-party integrations

### Updating References

To update to the latest version:

```bash
cd anthropic-cookbook/
git pull
```

## Why Gitignored?

These repositories are gitignored (not tracked by your dotfiles repo) because:
- They have their own git history
- You can update them independently
- They're large and change frequently
- You want to control when to pull updates

This keeps your dotfiles repo clean while still providing easy access to valuable reference materials.
