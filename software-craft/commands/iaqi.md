---
description: Iterative quality improvement loop with parallel reviewers and anchor-based drift prevention
argument-hint: <artifact-path> [--reviewers N] [--target X.X] [--max-iterations N]
allowed-tools:
  - Task
  - Read
  - Glob
  - Grep
  - Edit
  - Write
  - Bash
  - AskUserQuestion
model: opus
---

# IAQI: Intent-Anchored Quality Iteration

Invoke the `software-craft:iaqi` skill.

**Input**: $ARGUMENTS

**Defaults**:
- `--reviewers 5` — parallel reviewer agents
- `--target 9.0` — score threshold for success
- `--max-iterations 7` — iteration limit

Parse any `--flag value` pairs from arguments. The first non-flag argument is the artifact path.

**State file**: Created at `<artifact-dir>/.iaqi/<artifact-name>-<date>.md`
