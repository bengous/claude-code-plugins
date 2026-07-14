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

The wrapper pins the CLI to an exact version (resolved from `latest` at most
once per 24 h, cached in `~/.cache/agents-bridge/codex.version`) and falls back
to the last version that installed successfully when the npm registry is broken
or unreachable — a bad upstream release cannot kill a run that just worked.
`AGENTS_BRIDGE_CODEX_VERSION=<x.y.z>` freezes the version explicitly (used by
long orchestrations); it is the only env var the wrapper reads — codex-native
settings still go through codex's own flags.

## Default model

!`grep -E '^(model|model_reasoning_effort)' ~/.codex/config.toml 2>/dev/null || echo "(no ~/.codex/config.toml — codex uses its built-in default; the active model is printed in every 'exec' run header)"`

That is the **default** — and the only model name the skill can confirm. Codex
has no "list models" command and `-m` does not enumerate choices, so:

- Use the default unless the user names a specific model. Never guess names from training data.
- For another model, pass the user's name via `-m`; codex validates server-side and errors clearly on an unknown model (safe to try). Check codex docs if unsure of the exact name.
- Without `--json`, each `codex exec` run prints the active `model:` /
  `reasoning effort:` / `sandbox:` in its header — read it to confirm what ran.
  **With `--json` (the default invocation below) the header is suppressed and
  the event stream carries no config**, so what ran is exactly what you passed
  on the command line — which is why every resume must re-state its flags (see
  Follow-ups).

## Execution

**Default to read-only.** The uses below (review, debugging, architecture) are
all read-only — codex must not touch the workspace unless the user actually asks
it to make changes. Escalate the sandbox explicitly (`-s workspace-write`) only
then.

**Pass the prompt via a file on stdin, never inline.** Prompts carry backticks,
`$(...)`, quotes and apostrophes; inlined into the shell they break the command
or execute as substitutions in *this* agent's shell. Codex has a native
primitive for this: `-` reads the prompt from stdin. Write `$ARGUMENTS` to a
temp file with the Write tool (no shell involved), then redirect it in.

**Every first run starts a thread — capture its id.** Follow-ups in the same
task resume that thread (see Follow-ups below) instead of re-running a fresh
context-less `exec`, so the id must be captured on the *first* run, not
retrofitted when you realize you need it. `--json` emits a stable event stream
whose `thread.started` event carries the id; `-o` saves codex's final message
(with `--json`, stdout is events, not prose — read the reply from the `-o`
file). This is the default invocation:

```bash
# 1. Write the user's prompt with the Write tool first:
#    Write  /tmp/codex-prompt.md   <- contents = $ARGUMENTS
# 2. First run: read-only, prompt from stdin, JSONL captured for the thread id:
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

The `- < file` form sidesteps all shell-quoting issues, has no argv size limit,
and stdin closes at EOF by itself. Use the **same literal path** in the Write
step and the redirect — do not use `$TMPDIR` in the Write step (the Write tool
does not expand shell variables, the shell does; the two can diverge). If
concurrent sessions may run, pick unique filenames per run (prompt, `.jsonl`
and `.last` alike).

If you ever pass the prompt as an argument instead, append `</dev/null`:
with stdin piped-but-open, `codex exec` appends stdin as a `<stdin>` block and
blocks waiting for EOF even when a prompt argument was given.

**Trusted-directory check.** `codex exec` refuses to start unless its cwd is
inside a git repo (or a directory previously trusted in codex config), failing
with `Not inside a trusted directory and --skip-git-repo-check was not
specified.` You never see this when running from a project checkout; it bites
when you point `-C` at a scratch/temp workdir (e.g. to isolate parallel
agents). For throwaway non-git workdirs, pass `--skip-git-repo-check`
explicitly — and keep the flag off when cwd is a real checkout, the guard is
useful there.

## Follow-ups: resume by default

Any follow-up that builds on an earlier run in the same task — iterating on its
findings, pushing back, a review → fix → confirmation pass — **resumes the
thread** by the captured `$tid`. A fresh `exec` discards everything codex
already read and re-litigates it from zero.

**Resume does not inherit the first run's flags.** Verified on codex v0.144.1:
a thread started with `-s read-only` and `model_reasoning_effort=low` resumed
as `workspace-write (network access enabled)` at `medium` effort — `exec
resume` falls back to `~/.codex/config.toml` defaults, and it has no `-s` flag
at all. So **re-state sandbox, effort, and any non-default model on every
resume**, via `-c sandbox_mode=...` / `-c model_reasoning_effort=...` / `-m`:

```bash
# Follow-up: Write /tmp/codex-followup.md first, then resume by explicit id.
# Mirror the first run's settings — `-s X` becomes `-c sandbox_mode=X`, and any
# `-c` effort / `-m` model repeats verbatim (this example's first run was
# `-s read-only` with effort low):
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
- If you resume without `--json`, read the printed header (`sandbox:`,
  `reasoning effort:`, `model:`) before trusting the result; with `--json`
  there is no header, so the flags you pass are the only control.

### Overrides (codex native flags)

A model or effort the user explicitly asks for **overrides the default above** —
pass it directly, don't fall back to the default. This covers brand-new models
(nothing hardcodes the model list) and forcing a non-default effort like `xhigh`.
The wrapper forwards codex's own flags; codex validates and errors if a value is
wrong:

```bash
# e.g. user asked for gpt-5.6-sol at xhigh effort, read-only sandbox
# (still --json -o: overrides don't drop the thread-id capture)
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec \
  -m gpt-5.6-sol \
  -s read-only \
  -c model_reasoning_effort=xhigh \
  --json -o /tmp/codex.last \
  - < /tmp/codex-prompt.md \
  > /tmp/codex.jsonl
```

| Flag | Purpose |
|------|---------|
| `-m <model>` | Model — default from the probe above; codex errors on an unknown name. gpt-5.6 tiers: `gpt-5.6-sol` (flagship), `gpt-5.6-terra` (balanced), `gpt-5.6-luna` (fast/cheap) |
| `-c model_reasoning_effort=<level>` | Reasoning effort — common: `low`, `medium`, `high`, `xhigh`; gpt-5.6 Sol adds `max` and `ultra`; codex validates |
| `-s <mode>` | Sandbox — authoritative set from `codex exec --help`: `read-only`, `workspace-write`, `danger-full-access` |

## Model routing (gpt-5.6 tiers)

Benchmarks from [artificialanalysis.ai](https://artificialanalysis.ai/models)
(July 2026, effort `max` unless noted — re-check when a new generation ships):

| Tier | Intelligence (AA Index) | Coding (Terminal-Bench v2.1) | Agentic (GDPval-AA Elo) | Speed | $/1M in/out |
|------|------|------|------|------|------|
| `gpt-5.6-sol` | 59 | 88.0% (89.5% @ `xhigh`) | 1748 | n/a | $5 / $30 |
| `gpt-5.6-terra` | 55 | 88.0% | 1593 | 164 tok/s | $2.50 / $15 |
| `gpt-5.6-luna` | 51 | below top-30 | 1592 | 211 tok/s | $1 / $6 |

Routing rules:

- **Sol** — hard reasoning, architecture, security, adversarial critique, long
  agentic runs (tops τ³-Banking at 33.0%). Only tier with `max`/`ultra` gains
  that justify the price.
- **Terra** — default coding workhorse: **matches Sol on Terminal-Bench at
  `max` effort for half the price**. Feature work, bug fixes, tests, standard
  reviews.
- **Luna** — volume and mechanical work: quick probes, docs, formatting,
  sub-agent fan-out. Agentic Elo ≈ Terra at 40% of the cost, fastest tier.
- **Effort dominates tier**: Sol @ `low` scores 1445 Elo — *below* Luna @ `max`
  (1592). Raising effort on a cheaper tier often beats raising tier at low
  effort. Pick tier for the capability ceiling, effort for the depth of the
  single task at hand.

## Inside workflows/subagents (Claude Code)

The Agent/Workflow `model` param takes Claude models only — route codex through
a wrapper agent:

- Wrapper: a sonnet/low agent that writes a self-contained codex prompt, runs
  `codex exec` via Bash following this skill's invocation pattern, and returns
  the report (`schema` for structured output).
- Label the agent with a `sol:`/`terra:`/`luna:` prefix — the UI shows the
  wrapper's Claude model, not what codex ran.
- Codex can exceed Bash's 10-min default timeout → set an explicit timeout or
  run in background and poll.
- Parallel codex implementation agents → `isolation: 'worktree'`.

## When to Use

- **Code review**: Second opinion from GPT
- **Debugging**: Different perspective on errors
- **Architecture**: Cross-validate design decisions

For reviewing a **committed git diff**, prefer the official `/codex:review` —
it reads the diff directly. This skill is for ad-hoc prompts and conversation
context that never hit disk.

**Keep runs bounded.** Use `low`/`medium` effort for quick probes (or
`gpt-5.6-luna` for high-volume/mechanical work); `xhigh` plus a docs MCP can
rabbit-hole. `ultra` (gpt-5.6 Sol) spawns internal sub-agents and burns far more
tokens per turn — reserve it for genuinely hard problems the user asked for. To stop a runaway, target the real process
(`pkill -x codex` / kill its process group) — a `pkill -f 'codex exec'` matches
this agent's own command line and self-kills.
