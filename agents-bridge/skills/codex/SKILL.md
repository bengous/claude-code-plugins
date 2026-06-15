---
name: codex
description: Invoke OpenAI Codex CLI for cross-model collaboration
argument-hint: <prompt>
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
---

# Codex Bridge

Invoke the OpenAI Codex CLI for a second opinion from a non-Claude model. The
`scripts/codex` wrapper is a thin pass-through that auto-installs the CLI (via
npx) on first use — no manual install step needed. Pass codex's own flags
directly; the wrapper forwards everything.

## Default model

!`grep -E '^(model|model_reasoning_effort)' ~/.codex/config.toml 2>/dev/null || echo "(no ~/.codex/config.toml — codex uses its built-in default; the active model is printed in every 'exec' run header)"`

That is the **default** — and the only model name the skill can confirm. Codex
has no "list models" command and `-m` does not enumerate choices, so:

- Use the default unless the user names a specific model. Never guess names from training data.
- For another model, pass the user's name via `-m`; codex validates server-side and errors clearly on an unknown model (safe to try). Check codex docs if unsure of the exact name.
- Each `codex exec` run prints the active `model:` / `reasoning effort:` in its header — read it to confirm what ran.

## Execution

```bash
# Non-interactive run (preferred for agents)
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec "$ARGUMENTS"
```

### Overrides (codex native flags)

A model or effort the user explicitly asks for **overrides the default above** —
pass it directly, don't fall back to the default. This covers brand-new models
(nothing hardcodes the model list) and forcing a non-default effort like `xhigh`.
The wrapper forwards codex's own flags; codex validates and errors if a value is
wrong:

```bash
# e.g. user asked for gpt-5.5 at xhigh effort, read-only sandbox
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec \
  -m gpt-5.5 \
  -s read-only \
  -c model_reasoning_effort=xhigh \
  "$ARGUMENTS"
```

| Flag | Purpose |
|------|---------|
| `-m <model>` | Model — default from the probe above; codex errors on an unknown name |
| `-c model_reasoning_effort=<level>` | Reasoning effort — common: `low`, `medium`, `high`, `xhigh` (max for gpt-5.x); codex validates |
| `-s <mode>` | Sandbox — authoritative set from `codex exec --help`: `read-only`, `workspace-write`, `danger-full-access` |

## Resuming conversations

Codex prints a session ID after each run. Continue that conversation:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec resume <SESSION_ID> "Follow-up prompt..."
```

**When to resume:**
- Follow-up questions about previous work
- Iterating on generated code
- Asking for clarifications or modifications
- Building on prior context

Capture the session ID from the previous run's output to enable resumption.

## When to Use

- **Code review**: Second opinion from GPT
- **Debugging**: Different perspective on errors
- **Architecture**: Cross-validate design decisions
