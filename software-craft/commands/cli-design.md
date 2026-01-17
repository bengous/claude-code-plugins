---
description: Design CLI tools with exceptional UX - follows platform conventions, helpful errors, composable output
argument-hint: [description of the CLI tool to build]
---

# CLI Design

Apply the cli-design skill to create command-line interfaces that respect users' time and intelligence.

## Usage

```bash
/cli-design                           # Load the skill for current task
/cli-design a tool that processes logs  # Apply to specific CLI
```

## Your Task

**Step 1: Load the skill**

Read and internalize the guidance from:
```
${CLAUDE_PLUGIN_ROOT}/skills/cli-design/SKILL.md
```

**Step 2: Apply to context**

If `$ARGUMENTS` is provided:
- Use it as the CLI description
- Begin the Design Thinking process immediately
- Ask clarifying questions if needed, then implement

If no arguments:
- Confirm what CLI the user wants to build
- Then apply the skill's methodology

**Step 3: Follow the skill structure**

1. Answer the Design Thinking questions (Purpose, Users, Scope, Personality)
2. Apply the UX Guidelines (Progressive Disclosure, Error Messages, Output Design, etc.)
3. Avoid the anti-patterns explicitly listed
4. Verify against the Success Criteria before presenting

The skill provides the framework. Your job is to apply it with intention and craft.
