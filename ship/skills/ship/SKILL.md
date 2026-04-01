---
name: ship
description: >
  Ship a feature branch: prepare a clean PR (strip working files with
  intelligent suggestions), create/update the GitHub PR, then merge to main
  with GPG signing when ready. Detects lifecycle stage automatically.
  Use when: "ship", "prep pr", "create pr", "open pr", "merge to main",
  "submit for review", "push for review", "ship this branch".
disable-model-invocation: true
---

# Ship

Unified workflow for shipping a feature branch. Detects where you are in the
lifecycle and dispatches to the right phase.

## Context

- Branch: !`git branch --show-current`
- PR: !`gh pr view --json number,headRefName 2>/dev/null`
- Repo root: !`git rev-parse --show-toplevel 2>/dev/null`
- Config: !`cat .shiprc.json 2>/dev/null`

## Decision tree

Based on the context above, take exactly one path:

### No `.shiprc.json` found (Config = none)

Invoke `/ship-setup` to interactively create the config for this project.
After setup completes, re-evaluate the context and continue to the appropriate phase.

### No PR exists (PR = none)

Invoke `/ship-prep` to strip working files and create a PR.

### PR exists

Invoke `/ship-merge` to merge the PR branch into main.
