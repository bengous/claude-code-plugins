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

The wrapper pins the CLI version (24 h TTL, falls back to the last working
install if npm breaks). `AGENTS_BRIDGE_CODEX_VERSION=<x.y.z>` freezes it
explicitly — the only env var the wrapper reads; everything codex-native goes
through codex's own flags.

## Default model

!`grep -E '^(model|model_reasoning_effort)' ~/.codex/config.toml 2>/dev/null || echo "(no ~/.codex/config.toml — codex uses its built-in default; the active model is printed in every 'exec' run header)"`

That is the **default** — and the only model name the skill can confirm; never
guess names from training data. For another model, pass the user's name via
`-m` — codex validates server-side and errors clearly on an unknown model
(safe to try).

Without `--json`, each run prints the active `model:` / `reasoning effort:` /
`sandbox:` in its header — read it to confirm what ran. **With `--json` (the
default invocation below) that header is suppressed and the event stream
carries no config** — what ran is exactly what you passed on the command line,
which is why every resume must re-state its flags (see Follow-ups).

## Execution

**Default to read-only.** The uses below (review, debugging, architecture) are
all read-only — codex must not touch the workspace unless the user actually asks
it to make changes. Escalate the sandbox explicitly (`-s workspace-write`) only
then.

**Pass the prompt via a file on stdin, never inline.** Prompts carry backticks,
`$(...)`, quotes and apostrophes; inlined into the shell they break the command
or execute as substitutions in *this* agent's shell. Codex has a native
primitive for this: `-` reads the prompt from stdin. Write the user's request
to a temp file with the Write tool (no shell involved), then redirect it in.

**Every first run starts a thread — capture its id.** Follow-ups in the same
task resume that thread (see Follow-ups below), so the id must be captured on
the *first* run. `--json` emits a stable event stream whose `thread.started`
event carries the id; `-o` saves codex's final message (with `--json`, stdout
is events, not prose — read the reply from the `-o` file). Default invocation:

```bash
# 1. Write the user's prompt with the Write tool first:
#    Write  /tmp/codex-prompt.md   <- contents = the user's request, verbatim
# 2. First run: read-only, prompt from stdin, JSONL captured for the thread id.
#    No effort flag = config default; add -c model_reasoning_effort=low|medium
#    for quick probes (see "Keep runs bounded"):
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec \
  -s read-only --json -o /tmp/codex.last \
  - < /tmp/codex-prompt.md \
  > /tmp/codex.jsonl

# 3. Read the reply from /tmp/codex.last; keep the thread id for follow-ups:
tid="$(jq -r 'select(.type=="thread.started") | .thread_id // empty' \
        /tmp/codex.jsonl | head -n1)"
```

Never scrape the id from the human-readable header — the JSONL event is the
stable interface.

Use the **same literal path** in the Write step and the redirect — no `$TMPDIR`
in the Write step (the Write tool does not expand shell variables). If
concurrent sessions may run, pick unique filenames per run (prompt, `.jsonl`
and `.last` alike). If you ever pass the prompt as an argument instead, append
`</dev/null` — with stdin piped-but-open, codex blocks waiting for EOF.

**Trusted-directory check.** `codex exec` refuses to start unless cwd is inside
a git repo (or a codex-trusted directory). Bites when `-C` points at a
scratch/temp workdir: pass `--skip-git-repo-check` there — and only there; the
guard is useful in real checkouts.

## Follow-ups: resume by default

Any follow-up that builds on an earlier run in the same task — iterating on its
findings, pushing back, a review → fix → confirmation pass — **resumes the
thread** by the captured `$tid`. A fresh `exec` discards everything codex
already read and re-litigates it from zero.

**Resume does not inherit the first run's flags** — `exec resume` falls back to
`~/.codex/config.toml` defaults and has no `-s` flag at all. **Re-state
sandbox, effort, and any non-default model on every resume**, via
`-c sandbox_mode=...` / `-c model_reasoning_effort=...` / `-m`:

```bash
# Follow-up: Write /tmp/codex-followup.md first, then resume by explicit id.
# Mirror the first run's settings — `-s X` becomes `-c sandbox_mode=X`, and any
# effort / `-m` model repeats verbatim (this example's first run used effort low):
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec resume "${tid}" \
  -c sandbox_mode=read-only \
  -c model_reasoning_effort=low \
  --json -o /tmp/codex.last \
  - < /tmp/codex-followup.md \
  > /tmp/codex.jsonl
```

- **Never `resume --last`** — it races across codex runs in the same cwd.
- The thread id is stable across resumes (`thread.started` re-fires with the
  same id), so the same capture pipeline keeps working.

### Overrides (codex native flags)

A model or effort the user asks for overrides the default — add the flag to
either block above (nothing hardcodes the model list; codex validates):

| Flag | Purpose |
|------|---------|
| `-m <model>` | Model — default from the probe above; codex errors on an unknown name |
| `-c model_reasoning_effort=<level>` | Reasoning effort — common: `low`, `medium`, `high`, `xhigh` (some models add more); codex validates |
| `-s <mode>` | Sandbox — `read-only`, `workspace-write`, `danger-full-access` |

## Inside workflows/subagents (Claude Code)

The Agent/Workflow `model` param takes Claude models only — route codex through
a wrapper agent:

- Wrapper: a sonnet/low agent that writes a self-contained codex prompt, runs
  `codex exec` via Bash following this skill's invocation pattern, and returns
  the report (`schema` for structured output).
- Label the agent with the codex model it runs — the UI shows the wrapper's
  Claude model, not what codex ran.
- Codex can exceed Bash's 10-min default timeout → set an explicit timeout or
  run in background and poll.
- Parallel codex implementation agents → `isolation: 'worktree'`.

## When to Use

Ad-hoc second opinion — code review, debugging, architecture — on prompts and
conversation context that never hit disk. For a **committed git diff**, prefer
the official `/codex:review`, which reads the diff directly.

**Keep runs bounded.** Use `low`/`medium` effort for quick probes; high effort
plus a docs MCP can rabbit-hole. To stop a runaway, target the real process
(`pkill -x codex` / kill its process group) — a `pkill -f 'codex exec'` matches
this agent's own command line and self-kills.
