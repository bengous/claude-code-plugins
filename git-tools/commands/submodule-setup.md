---
description: Set up git submodule architecture with automated GitHub Actions sync
argument-hint: [--resume]
---

# Submodule Setup

Set up git submodule architecture with fully automated parent-child synchronization via GitHub Actions.

## Usage

```bash
/submodule-setup           # Start new setup
/submodule-setup --resume  # Resume interrupted setup
```

## Your Task

Invoke the submodule-setup skill:

```
Skill(skill: "submodule-setup")
```

If `$ARGUMENTS` contains `--resume`, inform the skill to check for existing `.submodule-setup-state.json` and resume from the last checkpoint.
