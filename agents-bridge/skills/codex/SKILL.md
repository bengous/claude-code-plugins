---
name: codex
description: Invoke OpenAI Codex CLI for cross-model collaboration
argument-hint: <prompt>
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
---

# Codex Bridge

Invoke OpenAI Codex CLI for cross-model collaboration.

## Current Configuration

!`"${CLAUDE_PLUGIN_ROOT}/scripts/codex" --info 2>&1 || echo "(codex CLI not found -- install with: npm install -g @openai/codex)"`

## Execution

Use the configuration above to determine the current default model and available overrides. Do NOT guess model names.

```bash
# Run with prompt
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec "$ARGUMENTS"

# Or with overrides (use values from Current Configuration above)
CODEX_MODEL=<model> CODEX_REASONING=<level> "${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec "$ARGUMENTS"

# Resume a previous conversation
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec resume <SESSION_ID> "Follow up prompt..."
```

## Resuming Conversations

Codex returns a session ID after each run. To continue that conversation:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec resume <SESSION_ID> "Follow up prompt..."
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
| `CODEX_SANDBOX` | Sandbox mode: `read-only`, `workspace-write`, `danger-full-access` (exec only) |

## When to Use

- **Code review**: Second opinion from GPT
- **Debugging**: Different perspective on errors
- **Architecture**: Cross-validate design decisions
