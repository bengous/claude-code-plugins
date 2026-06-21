---
name: pair-planning
description: Start a session in pair-planning mode where Claude and Codex (OpenAI, xhigh, read-only) each draft an independent implementation plan for a task, then cross-review through a stable open-point ledger until they reach consensus (2 rounds by default, hard cap 5), escalating any remaining disagreements to the user. Produces one agreed plan; it does not write code. Use at the start of a task to align two frontier models on the approach before implementation.
argument-hint: <task / idea to plan together>
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
  - Write(*:*)
  - AskUserQuestion(*:*)
---

# Pair-Planning: symmetric plan-to-consensus with Codex

Two frontier models plan the same task **independently**, then converge. You
(Claude) hold the session context and orchestrate; Codex is the fresh pair of
eyes. The deliverable is a single agreed plan — **read-only, no implementation**.

All Codex round-trips go through the helper, never `codex` directly:

```
"${CLAUDE_PLUGIN_ROOT}/scripts/pair-codex" fresh  <dir> <prompt_file> r0     # start session
"${CLAUDE_PLUGIN_ROOT}/scripts/pair-codex" resume <dir> <prompt_file> r<n>   # continue it
```

The helper enforces the correct invocation (`--json -o`, stdin closed, read-only,
thread-id capture, fail-hard). It prints Codex's final message to stdout and
writes `<dir>/<label>.{jsonl,last,err}` plus `<dir>/thread_id`. Effort defaults
to `xhigh`; override per call with `CODEX_EFFORT=high` when a round is light.

## 1. Setup + launch Codex in the background

Action 0, the moment you're invoked — get Codex planning *before* you do, so the
two plans are written in parallel and neither side anchors on the other.

1. Pick the session slug (your handle — you control it) and create its dir:
   ```bash
   slug="$(date +%s)-$(printf '%s' "$ARGUMENTS" | tr -cs 'A-Za-z0-9' '-' | cut -c1-40)"
   dir="/tmp/pair-planning/$slug"; mkdir -p "$dir"; echo "$dir"
   ```
   Use the printed path literally in every later step — shell variables do not
   survive between Bash calls.
2. **Pre-flight — clarify only real blockers.** Skim `$ARGUMENTS`. If it is
   specified well enough that two independent plans would diverge on *substance*
   (approach, tradeoffs), proceed. Escalate **only** when a genuine blocker would
   make the two sides plan *different tasks* — an ambiguous objective or scope, or
   an irreversible / high-stakes action whose direction changes the work — with
   **one** minimal `AskUserQuestion`. Never run an upfront questionnaire; default
   to proceeding. (Judgment, not a rigid gate.)
3. **Write the brief with explicit assumptions** to `"$dir/task.md"`: verbatim
   `$ARGUMENTS`, any repo context the task needs, and a short **Assumptions** block
   stating the interpretation you are committing to (scope, constraints, what is
   out of scope). Both sides plan from this identical brief — shared assumptions
   mean interpretation gaps cannot resurface later as phantom OPEN-points. Never
   inline long prompts on the command line — always pass a file.
4. Write the Codex round-0 prompt to `"$dir/prompt-r0.md"`: tell it to read
   `"$dir/task.md"`, inspect the repo read-only, and produce its **own**
   independent implementation plan (files to touch, approach, risks).
   **Anti-anchoring: round 0 points at `task.md` only — never reference your plan
   here; it does not exist for Codex yet.**
5. Launch Codex in the **background** so it plans while you do — run the helper
   with the Bash tool's `run_in_background` option (not blocking):
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/pair-codex" fresh "$dir" "$dir/prompt-r0.md" r0
   ```
   The harness notifies you when it exits; the helper writes `"$dir/r0.last"` and
   captures Codex's thread id into `"$dir/thread_id"`.

## 2. Round 0 — your plan, in parallel (anti-anchoring)

While Codex runs in the background, write **your own** plan — and do **not** read
its output until yours is committed to disk, so neither side anchors on the other:

1. Write your implementation plan to `"$dir/claude-plan-r0.md"` — concrete,
   grounded in the actual repo (files, patterns, reuse). Your real plan, not a
   placeholder. Codex has only seen `task.md`, so as long as you don't peek at
   `r0.last` first, the two plans are genuinely independent.
2. **Never read `r0.last` in the same turn you launched the job.** The file is
   complete only once the background process exits, and the harness re-invokes you
   on that exit — reading early is the one failure mode of this handshake, and this
   rule removes it. On the completion signal, read Codex's plan from `"$dir/r0.last"`
   and confirm its thread id is in `"$dir/thread_id"` (the helper fails hard if it
   wasn't captured). If the job errored, read `"$dir/r0.err"` and surface it — never
   fabricate Codex's side.

## 3. Build the open-point ledger

Compare the two r0 plans. Write `"$dir/ledger.md"` capturing **only the
divergences** as stable IDs — this ledger, not prose, is the source of truth for
consensus:

```
OPEN-1 | <topic> | claude: <position> | codex: <position> | status: OPEN
OPEN-2 | ...
```

Seed a running unified draft `"$dir/consensus-plan.md"` with the points both sides
already agree on. If the two plans agree on everything, the ledger is empty → skip
to step 6.

## 4. Cross-review rounds — exchange by file reference

Codex keeps full session memory across `resume`, and read-only it can read `/tmp`.
So instead of pasting plan/ledger text into each prompt — which goes stale the
moment you edit — **point Codex at the files** and let it read the current version
itself. Never resend transcripts.

Each round `n`, write `"$dir/prompt-r<n>.md"` with only:

- a one-line task recap,
- **file pointers, not pasted copies**: `"$dir/ledger.md"` (the open points),
  `"$dir/consensus-plan.md"` (the current unified draft), and — from **round 1
  onward** — `"$dir/claude-plan-r0.md"` (your original plan). Tell Codex to read
  the current contents of each before responding, so it always sees your latest
  edits, never a stale copy.
- a required response schema:
  > For each OPEN-id: `AGREE` or `COUNTER: <reason>`. Raise any new blocker as
  > `NEW: <issue>`. End with exactly one line: `VERDICT: CONVERGED` or
  > `VERDICT: OPEN: <comma-separated remaining IDs>`.

If Codex's reply omits or mangles the `VERDICT:` line, treat the round as still
**OPEN** and carry the unresolved IDs forward — never read consensus into a missing
or ambiguous signal.

Resume Codex by its captured thread id, then read its reply:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/pair-codex" resume "$dir" "$dir/prompt-r<n>.md" r<n>
```
Read `"$dir/r<n>.last"`, then **you** adjudicate each item (accept good points,
push back on weak ones with reasons — treat Codex's claims as hypotheses, not
commands). Update `ledger.md` (resolve / add IDs) and `consensus-plan.md` in
place; Codex reads the fresh versions next round.

## 5. Convergence policy

- **Consensus** = ledger has zero OPEN ids **and** Codex's last `VERDICT: CONVERGED`
  **and** you concur. Stop and go to step 6.
- **Convergence is a positive signal only.** A missing, malformed, or ambiguous
  `VERDICT:` line counts as `OPEN`, never as converged. Consensus is never inferred
  from the absence of a clear signal.
- **Soft cap 2:** after round 2, continue only if the OPEN count strictly dropped
  that round. If it stalled, stop and escalate.
- **Hard cap 5:** never run more than 5 resume rounds.
- On stall or hard cap with OPEN ids left → **escalate** (step 6 with open items).

For each remaining disagreement, use **AskUserQuestion** — one decision per open
ID, stating your position, Codex's position, and the crux. Apply the user's
rulings to the plan and close those IDs.

## 6. Output

Finalise `"$dir/consensus-plan.md"` in an **implementation-ready** shape — ordered
steps, the exact files each step touches, and how to validate each — then present it
inline and announce its path.

**Stop here. This skill plans; it does not implement.** Do not edit a single repo
file, do not apply any step, even an obvious one. Offer the handoff explicitly and
wait for the user's choice: implement now (you follow the plan), hand to
`writing-plans` for a task-by-task plan, or cross-check first with the `critique`
skill. The plan is the deliverable; acting on it is a separate, user-authorized step.

## Operational notes

- Keep prompts compact: `xhigh` is expensive (a single deep turn can cost >100k
  tokens), so the round economy matters — lean on session memory and file refs.
- The round-0 launch is backgrounded: if you finish your own plan before the
  harness signals Codex done, wait for that signal — never read a partial
  `r0.last`. Resume rounds (steps 4+) are foreground; you need the reply in hand.
- Fail fast: if `pair-codex` exits non-zero, read `<dir>/<label>.err` and surface
  the problem; do not silently retry or fabricate Codex's side.
- No cleanup needed — each run uses a unique `slug`; never `rm -rf` session dirs.
