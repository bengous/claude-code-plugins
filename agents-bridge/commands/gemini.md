---
description: Invoke Google Gemini CLI for cross-model collaboration
argument-hint: <prompt>
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
---

# Gemini Bridge

Invoke Google Gemini CLI for cross-model collaboration.

## Before Using

**Always run `gemini --info` first** to discover:
- Current CLI version
- Available configuration options
- How to list models interactively

Do NOT guess model names from training data.

## Usage

```
/gemini Review the authentication implementation in src/auth/
/gemini What's wrong with this error? <paste error>
```

## Execution

```bash
# First: discover current config
gemini --info

# Then: run with prompt (one-shot)
gemini "prompt"

# Or with overrides
GEMINI_MODEL=<model> gemini "prompt"

# Auto-approve all actions
GEMINI_YOLO=true gemini "prompt"
```

## Configuration (env vars)

| Variable | Description |
|----------|-------------|
| `GEMINI_MODEL` | Model override |
| `GEMINI_SANDBOX` | Enable sandbox mode (`true`/`false`) |
| `GEMINI_YOLO` | Auto-approve all actions (`true`/`false`) |

## When to Use

- **Code review**: Second opinion from Gemini
- **Debugging**: Different perspective on errors
- **Architecture**: Cross-validate design decisions
