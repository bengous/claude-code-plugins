---
name: codex
description: Invoke the OpenAI Codex CLI for cross-model collaboration, a second opinion, or delegated work. Use when the user asks Codex to review, debug, explain, plan or implement something, or names a Codex model.
argument-hint: <prompt>
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts *)
  - Read(~/.cache/agents-bridge/**)
  - Edit(~/.cache/agents-bridge/codex/**)
---

# Codex Bridge

Every Codex call goes through `codex-run.ts`, which owns the invocation: a
private run directory, the resolved settings in `run.json`, one directory per
turn, a detached supervisor that outlives the Bash call, and resume on the same
thread with the same settings. Pass the user's request through; do not call the
codex CLI directly.

## Models

<codex_models>
!`"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" models`
</codex_models>

Without `--role` or `-m`, the run uses the codex configuration default. Pick a
role when the work calls for a tier; pass `-m <slug>` only when the user names
a model, with a slug from the list above.

| Work | Role |
|------|------|
| Implementation, debugging, judgment on code | `coding` |
| Review, audit, security, hard reasoning | `audit` |
| Tests, gates, research, bounded mechanical work | `bounded` |

`--effort <level>` overrides the role's effort; it must appear in that model's
`efforts:` list. `codex-run.ts` checks both against the catalog and refuses an
unknown pair with exit 2.

## Run a turn

1. Create the run directory. Use the printed path literally in every later
   step: shell variables do not survive between Bash calls.

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" new codex
   ```

2. Write the task for Codex to `<dir>/prompt.md` with the Write tool, as an
   instruction addressed to Codex: the user's request verbatim, minus the parts
   addressed to you (which model, role or effort to use, how to report back to
   the user). Codex reads "ask Codex to…" as an order to run the codex CLI. The
   prompt never goes on the command line.

3. Start the turn from the repository Codex works in (`-C <dir>` otherwise):

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" start <dir> --prompt-file <dir>/prompt.md
   ```

   Add `--role <role>`, `-m <slug>` or `--effort <level>` as above. Add
   `--skip-git-repo-check` only when `-C` points outside a git repository.
   Run each `codex-run.ts` command alone, as written: a `;`, `&&` or
   `echo $?` added to it asks for permission. The envelope's `status` already
   gives the exit code.

The first stdout line is a JSON envelope (`status`, `thread_id`, `model`,
`effort`, `mode`, `blocked`, `error`, `final_message_file`). Once the turn is
over, a `--- final message ---` line follows, then Codex's answer. The exit
code carries the status:

| Exit | Status | Next step |
|------|--------|-----------|
| 0 | completed | Relay the answer, then check its claims before acting on them |
| 1 | failed | Report `error`; do not retry blindly |
| 2 | usage error | Fix the command from the message on stderr |
| 10 | running | Run `wait <dir>` again; the turn goes on without you |
| 11 | blocked | See "Blocked actions" below |
| 124 | deadline | The turn hit `--deadline` (default 2 h) and was interrupted |
| 130 | cancelled | The turn was cancelled |

`start` and `resume` wait up to 540 s, under the 600 s Bash cap. A longer turn
returns 10 and keeps running; pick it up with:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" wait <dir>
```

`status <dir>` reads the envelope without waiting and exits 0. `cancel <dir>`
interrupts the turn. `--wait 0` returns at once, so you can work in parallel
and call `wait` later.

## Read-only or write

Runs are read-only by default: review, debugging, architecture and questions
never touch the workspace. When the user asks Codex to change files, add
`--mode write`. Codex then works in its workspace-write sandbox under its own
auto-review, which judges every request to go beyond the sandbox, and its
answer comes back as the `answer` of a JSON object, with denied actions listed
apart. Add `--git-write` only when Codex must stage or commit: it grants the
repository's git directories, which the sandbox otherwise keeps read-only.

## Blocked actions

Exit 11 means an action stayed blocked. Each item of `blocked` gives the
`action`, its `cwd`, the `rationale` and the `cause` (`review_denial` or
`sandbox_failure`). You take the human's place on each item:

- By default, resume the thread with a ruling: a safer alternative, or the
  reason the action is legitimate. Codex's auto-review stays active and may
  deny it again.
- Perform the action yourself only when it sits squarely inside the user's
  request, and say that you did: the enforcing check becomes Claude Code's
  permission system instead of Codex's auto-review.
- Never loosen the sandbox (`danger-full-access`, bypass flags) to get past a
  denial.

## Follow-ups

A follow-up that builds on the turn (iterate on findings, push back, fix and
confirm) resumes the thread, so Codex keeps what it already read. Write the
follow-up to a new file in the run directory, then:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" resume <dir> --prompt-file <dir>/followup-2.md
```

Resume replays the model, effort, mode, cwd and writable roots recorded in
`run.json`; only `--effort`, `--output-schema`, `--deadline` and `--wait` can
change per turn. Each turn keeps its own files under `<dir>/turn-<n>/`. The
`allowed-tools` grant covers the invoking turn only, so a follow-up in a later
turn may prompt.

## Structured answers

`--output-schema <file>` makes Codex answer as JSON matching that schema; the
final message is the JSON, formatted. The schema applies to that turn only.

## Inside workflows and subagents

The Agent and Workflow `model` parameter takes Claude models only, so route
Codex through a wrapper agent: a sonnet/low agent that writes the prompt, runs
`codex-run.ts` as above and returns the answer. The wrapper does no reasoning.
Label the agent with the Codex model it runs, since the UI shows the wrapper's
Claude model. Parallel write runs need `isolation: 'worktree'`.

## When to use

A second opinion (code review, debugging, architecture) on a prompt or on
conversation context that never hit disk, or work delegated to Codex. For
local git changes, uncommitted work or a branch against its base, use
`/agents-bridge:adversarial-review`, which reads the diff directly.

Keep runs bounded: `low` or `medium` effort for quick probes; high effort plus
a docs MCP can rabbit-hole. To stop a runaway turn, `cancel <dir>`.
