---
description: Add research directive to global CLAUDE.md
allowed-tools:
  - Read(*:*)
  - Edit(*:*)
  - Write(*:*)
  - Bash(cat:*)
  - AskUserQuestion(*:*)
---

# Setup Research Directive

Inject the research requirements directive into the user's global CLAUDE.md.

## Step 1: Read the Template

Read the template from `${CLAUDE_PLUGIN_ROOT}/templates/research-directive.md`.

## Step 2: Check Current State

Read `~/.claude/CLAUDE.md` and check:
1. Does the file exist?
2. Is there already a `## Research Requirements` section?

If the section already exists, inform the user and ask if they want to replace it.

## Step 3: Present and Confirm

Show the user the directive that will be added:

```
This will add the following to ~/.claude/CLAUDE.md:

<show template content>
```

Use `AskUserQuestion` to confirm:
- Question: "Add this research directive to your global CLAUDE.md?"
- Options:
  - "Yes, append to my CLAUDE.md"
  - "Preview the full result first"
  - "Cancel"

If "Preview", show how the final file will look, then ask again.

## Step 4: Apply Changes

If confirmed:
- If no existing `## Research Requirements`: append template to end of file
- If existing section: use Edit to replace the old section with new one

Report success:
```
Added research directive to ~/.claude/CLAUDE.md

The `/claude-meta-tools:research` command will now be suggested when:
- You need documentation lookups
- MCP discovery is required
- You're unsure which tool to use
```
