---
description: Interactively create .shiprc.json for a project. Called by /ship when no config exists.
allowed-tools:
  - Write
---

# Ship Setup

Create a `.shiprc.json` config file for this project. This file tells `/ship` which
working files to strip from PR branches.

## Context

- Repo root: !`git rev-parse --show-toplevel`
- Top-level contents: !`ls -1`
- Gitignore: !`cat .gitignore 2>/dev/null`
- Existing plans/docs dirs: !`ls -d plans/ docs/ notes/ drafts/ .scratch/ scratch/ 2>/dev/null`

## Flow

### 1. Analyze the project

Look at the directory structure, `.gitignore`, and common conventions. Identify
directories that likely contain working files (plans, notes, drafts, specs)
that should not end up in PRs.

### 2. Suggest patterns

Present your findings with a justification for each pattern. For example:

> I found these directories that look like working artifacts:
> - `plans/` -- development plans and design docs
> - `docs/superpowers/` -- skill/plugin documentation drafts
>
> These would be stripped from PR branches. Your source code stays untouched.

Use **AskUserQuestion** with options:
- "Accept these patterns"
- "Let me adjust"
- "Skip -- I don't need file stripping"

### 3. Create the config

Write `.shiprc.json` at the repo root:

```json
{
  "strip": {
    "patterns": ["plans/", "docs/superpowers/"]
  }
}
```

If the user chose "Skip", create the config with an empty patterns array:
```json
{
  "strip": {
    "patterns": []
  }
}
```

### 4. Confirm and continue

Tell the user the config was created. Then evaluate whether to continue with
`/ship-prep` (if no PR exists) or `/ship-merge` (if PR exists).

## Rules

- Never add source code directories to the strip patterns.
- Patterns must end with `/` (directories only).
- The config file should be committed to the repo so the whole team uses it.
