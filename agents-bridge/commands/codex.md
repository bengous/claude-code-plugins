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

# Resume a previous conversation
codex exec resume <SESSION_ID> "Follow up prompt..."
```

## Resuming Conversations

Codex returns a session ID after each run. To continue that conversation:

```bash
# Previous run returned session ID: abc123xyz
codex exec resume abc123xyz "Now add tests for the changes you made"
```

**When to resume:**
- Follow-up questions about previous work
- Iterating on generated code
- Asking for clarifications or modifications
- Building on prior context

**Important:** Capture the session ID from the previous run's output to enable resumption.

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
