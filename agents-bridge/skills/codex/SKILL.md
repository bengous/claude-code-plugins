---
name: codex
description: Invoke OpenAI Codex CLI for cross-model collaboration
argument-hint: <prompt>
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
  - Write(*:*)
---

# Codex Bridge

Invoke the OpenAI Codex CLI for a second opinion from a non-Claude model. The
`scripts/codex` wrapper is a thin pass-through that auto-installs the CLI via
npx on first use (requires `node`/`npx` on PATH, or `mise`). Pass codex's own
flags directly; the wrapper forwards everything.

## Default model

!`grep -E '^(model|model_reasoning_effort)' ~/.codex/config.toml 2>/dev/null || echo "(no ~/.codex/config.toml — codex uses its built-in default; the active model is printed in every 'exec' run header)"`

That is the **default** — and the only model name the skill can confirm. Codex
has no "list models" command and `-m` does not enumerate choices, so:

- Use the default unless the user names a specific model. Never guess names from training data.
- For another model, pass the user's name via `-m`; codex validates server-side and errors clearly on an unknown model (safe to try). Check codex docs if unsure of the exact name.
- Each `codex exec` run prints the active `model:` / `reasoning effort:` in its header — read it to confirm what ran.

## Execution

**Default to read-only.** The uses below (review, debugging, architecture) are
all read-only — codex must not touch the workspace unless the user actually asks
it to make changes. Escalate the sandbox explicitly (`-s workspace-write`) only
then.

**Pass the prompt via a file on stdin, never inline.** Prompts carry backticks,
`$(...)`, quotes and apostrophes; inlined into the shell they break the command
or execute as substitutions in *this* agent's shell. Codex has a native
primitive for this: `-` reads the prompt from stdin. Write `$ARGUMENTS` to a
temp file with the Write tool (no shell involved), then redirect it in:

```bash
# 1. Write the user's prompt with the Write tool first:
#    Write  /tmp/codex-prompt.md   <- contents = $ARGUMENTS
# 2. Then run codex, read-only, prompt from stdin:
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec \
  -s read-only \
  - < /tmp/codex-prompt.md
```

The `- < file` form sidesteps all shell-quoting issues, has no argv size limit,
and stdin closes at EOF by itself. Use the **same literal path** in the Write
step and the redirect — do not use `$TMPDIR` in the Write step (the Write tool
does not expand shell variables, the shell does; the two can diverge). If
concurrent sessions may run, pick a unique filename per run.

If you ever pass the prompt as an argument instead, append `</dev/null`:
with stdin piped-but-open, `codex exec` appends stdin as a `<stdin>` block and
blocks waiting for EOF even when a prompt argument was given.

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
  - < /tmp/codex-prompt.md
```

| Flag | Purpose |
|------|---------|
| `-m <model>` | Model — default from the probe above; codex errors on an unknown name |
| `-c model_reasoning_effort=<level>` | Reasoning effort — common: `low`, `medium`, `high`, `xhigh` (max for gpt-5.x); codex validates |
| `-s <mode>` | Sandbox — authoritative set from `codex exec --help`: `read-only`, `workspace-write`, `danger-full-access` |

## Resuming conversations

To continue a conversation you need its **thread id**. Do not scrape it from the
human-readable header — capture the run as JSONL and parse it, which is stable:

```bash
# First run — capture JSONL so the thread id can be read back reliably.
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec \
  -s read-only --json -o /tmp/codex.last \
  - < /tmp/codex-prompt.md \
  > /tmp/codex.jsonl

tid="$(jq -r 'select(.type=="thread.started") | .thread_id // empty' \
        /tmp/codex.jsonl | head -n1)"

# Follow-up — resume by explicit thread id (never `resume --last`; it races
# across codex runs in the same cwd). `exec resume` has no -s flag; it inherits
# the original sandbox.
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec resume "${tid}" \
  - < /tmp/codex-followup.md
```

`-o <file>` holds codex's final message; the `.jsonl` holds the full event
stream. **When to resume:** follow-ups on prior work, iterating on generated
code, clarifications — anything that builds on earlier context.

## When to Use

- **Code review**: Second opinion from GPT
- **Debugging**: Different perspective on errors
- **Architecture**: Cross-validate design decisions

For reviewing a **committed git diff**, prefer the official `/codex:review` —
it reads the diff directly. This skill is for ad-hoc prompts and conversation
context that never hit disk.

**Keep runs bounded.** Use `low`/`medium` effort for quick probes; `xhigh` plus
a docs MCP can rabbit-hole. To stop a runaway, target the real process
(`pkill -x codex` / kill its process group) — a `pkill -f 'codex exec'` matches
this agent's own command line and self-kills.
