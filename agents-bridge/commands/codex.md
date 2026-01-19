---
description: Invoke OpenAI Codex CLI for cross-model collaboration
argument-hint: <prompt>
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
---

# Codex Bridge

Invoke OpenAI Codex CLI for cross-model collaboration.

## Before Using

**Always run `codex --info` first** to discover:
- Current default model and reasoning effort
- Available configuration options
- Environment variable overrides

Do NOT guess model names from training data.

## Usage

```
/codex Review the authentication implementation in src/auth/
/codex What's wrong with this error? <paste error>
```

## Execution

```bash
# First: discover current config
codex --info

# Then: run with prompt
codex exec "prompt"

# Or with overrides (use values from --info)
CODEX_MODEL=<model> CODEX_REASONING=<level> codex exec "prompt"
```

## Configuration (env vars)

| Variable | Description |
|----------|-------------|
| `CODEX_MODEL` | Model override |
| `CODEX_REASONING` | Reasoning effort: `low`, `medium`, `high`, `xhigh` |
| `CODEX_SANDBOX` | Sandbox mode: `read-only`, `workspace-write`, `danger-full-access` |
| `CODEX_APPROVAL` | Approval policy: `untrusted`, `on-failure`, `on-request`, `never` |

## When to Use

- **Code review**: Second opinion from GPT
- **Debugging**: Different perspective on errors
- **Architecture**: Cross-validate design decisions
