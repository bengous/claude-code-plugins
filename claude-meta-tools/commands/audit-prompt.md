---
description: Audit prompts against Claude 4 best practices and optionally generate improvements
argument-hint: "<file-path or inline prompt>"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(curl:*)
  - AskUserQuestion
  - Write
  - Edit
model: claude-opus-4-5
---

# Prompt Auditor

Evaluate prompts (commands, skills, agent docs) against Claude 4 best practices.

## Input

**$ARGUMENTS**

## Step 1: Load the Prompt

- If input looks like a file path (contains `/` or ends in `.md`), Read the file
- Otherwise, treat as inline prompt text

## Step 2: Fetch Best Practices

Fetch the latest best practices:

```bash
curl -s "https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices.md"
```

**If curl fails**, read the cached fallback:
`${CLAUDE_PLUGIN_ROOT}/references/claude4-best-practices.md`

## Step 3: Analyze

Evaluate the prompt against the best practices. Score each applicable category:
- ✅ Good
- ⚠️ Needs improvement
- ❌ Missing/problematic
- N/A - Not applicable

Key categories to check:
1. Explicitness & clarity
2. Positive framing (what TO DO vs what to avoid)
3. Structure (XML tags, organization)
4. Examples (when needed)
5. Tool usage guidance
6. Verification & success criteria
7. Scope appropriateness
8. Claude 4-specific considerations

## Step 4: Present Findings

```
## Audit: [filename or "Inline Prompt"]

### Summary
[1-2 sentence assessment]

### Scores
| Category | Score | Notes |
|----------|-------|-------|
| ... | ✅/⚠️/❌ | ... |

### Priority Issues
1. **[Issue]**
   - Current: `[quote]`
   - Problem: [why]
   - Fix: `[improved version]`
```

## Step 5: Offer Revision

Use `AskUserQuestion`:
- "Would you like me to generate a revised version?"
- Options: Full revision / Priority fixes only / No thanks

If yes, apply improvements and present revised prompt. If input was a file, offer to write changes back.
