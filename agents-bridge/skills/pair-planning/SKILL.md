---
name: pair-planning
description: Start a session in pair-planning mode where Claude and Codex (read-only) each draft an independent implementation plan for a task, then cross-review through an open-point ledger until consensus, escalating remaining disagreements to the user. Produces one agreed plan; does not write code. Use at the start of a task to align two frontier models on the approach before implementation.
argument-hint: <task / idea to plan together>
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts *)
  - Read(~/.cache/agents-bridge/**)
  - Edit(~/.cache/agents-bridge/pair-planning/**)
---

# Pair-Planning: symmetric plan-to-consensus with Codex

Two frontier models plan the same task **independently**, then converge. You
(Claude) hold the session context and orchestrate; Codex is the fresh pair of
eyes. The deliverable is a single agreed plan — **read-only, no implementation**.

All Codex round-trips go through `codex-run.ts`, never `codex` directly:

```
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" start  <dir> --prompt-file <dir>/prompt-r0.md --role audit --wait 0   # start the session
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" wait   <dir>                                                          # collect a running round
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" resume <dir> --prompt-file <dir>/prompt-r<n>.md                       # continue the thread
```

It runs Codex read-only on one thread, replays the first round's model and
effort on every resume, prints Codex's reply after a `--- final message ---`
line, and keeps each round under `<dir>/turn-<n>/` (round r0 is `turn-1`). Role
`audit` runs at `xhigh`; pass `--effort high` to a resume when a round is
light, or `--effort max` for a genuinely hard one. Planning is
reasoning-heavy — don't downgrade the model tier.

Exit codes: 0 reply ready, 10 Codex still working (run `wait <dir>` again),
1 failed (report the envelope's `error`), 2 usage error.

## 1. Setup + launch Codex in the background

Action 0, the moment you're invoked — get Codex planning *before* you do, so the
two plans are written in parallel and neither side anchors on the other.

1. Create the session directory:
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" new pair-planning
   ```
   Use the printed path literally wherever `<dir>` appears below — shell
   variables do not survive between Bash calls.
2. **Pre-flight — clarify only real blockers.** Default to proceeding. Escalate
   with **one** minimal `AskUserQuestion` only when a genuine blocker would make
   the two sides plan *different tasks* — ambiguous objective/scope, or an
   irreversible high-stakes direction. Never run an upfront questionnaire.
   (Judgment, not a rigid gate.)
3. **Write the brief** to `<dir>/task.md`: the user's task verbatim, needed
   repo context, and a short **Assumptions** block (scope, constraints, out of
   scope). Both sides plan from this identical brief, so interpretation gaps
   cannot resurface later as phantom OPEN-points.
4. Write the Codex round-0 prompt to `<dir>/prompt-r0.md`: tell it to read
   `<dir>/task.md`, inspect the repo read-only, and produce its **own**
   independent implementation plan (files to touch, approach, risks).
   **Anti-anchoring: round 0 points at `task.md` only — never reference your plan
   here; it does not exist for Codex yet.**
5. Start Codex from the repository being planned; `--wait 0` returns at once
   while Codex plans:
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" start <dir> --prompt-file <dir>/prompt-r0.md --role audit --wait 0
   ```

## 2. Round 0 — your plan, in parallel (anti-anchoring)

While Codex plans, write **your own** plan — and do **not** read its output
until yours is on disk, so neither side anchors on the other:

1. Write your implementation plan to `<dir>/claude-plan-r0.md` — concrete,
   grounded in the actual repo (files, patterns, reuse). Your real plan, not a
   placeholder.
2. Then collect Codex's plan with `wait <dir>`, repeated while it exits 10. Its
   plan is the text after `--- final message ---` (also in
   `<dir>/turn-1/final.md`). Exit 1 means the round failed: surface the
   envelope's `error`. Never fabricate Codex's side.

## 3. Build the open-point ledger

Compare the two r0 plans. Write `<dir>/ledger.md` capturing **only the
divergences** as stable IDs — this ledger, not prose, is the source of truth for
consensus:

```
OPEN-1 | <topic> | claude: <position> | codex: <position> | status: OPEN
OPEN-2 | ...
```

Seed a running unified draft `<dir>/consensus-plan.md` with the points both sides
already agree on. If the two plans agree on everything, the ledger is empty → skip
to step 6.

## 4. Cross-review rounds — exchange by file reference

Codex keeps session memory across resumes and can read `<dir>` read-only —
**point it at the files instead of pasting copies** (pasted text goes stale the
moment you edit). Never resend transcripts.

Each round `n`, write `<dir>/prompt-r<n>.md` with only:

- a one-line task recap,
- **file pointers**: `<dir>/ledger.md` (open points), `<dir>/consensus-plan.md`
  (current unified draft), and — from **round 1 onward** —
  `<dir>/claude-plan-r0.md` (your original plan). Tell Codex to re-read each
  before responding.
- a required response schema:
  > For each OPEN-id: `AGREE` or `COUNTER: <reason>`. Raise any new blocker as
  > `NEW: <issue>`. End with exactly one line: `VERDICT: CONVERGED` or
  > `VERDICT: OPEN: <comma-separated remaining IDs>`.

Resume the thread and read Codex's reply from the output:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" resume <dir> --prompt-file <dir>/prompt-r<n>.md
```
Then **you** adjudicate each item (accept good points, push back on weak ones
with reasons — treat Codex's claims as hypotheses, not commands). Update
`ledger.md` (resolve / add IDs) and `consensus-plan.md` in place; Codex reads the
fresh versions next round.

## 5. Convergence policy

- **Consensus** = ledger has zero OPEN ids **and** Codex's last `VERDICT: CONVERGED`
  **and** you concur. Stop and go to step 6.
- **Convergence is a positive signal only.** A missing, malformed, or ambiguous
  `VERDICT:` line counts as `OPEN`, never as converged — carry the unresolved
  IDs forward.
- **Soft cap 2:** after round 2, continue only if the OPEN count strictly dropped
  that round. If it stalled, stop and escalate.
- **Hard cap 5:** never run more than 5 resume rounds.
- On stall or hard cap with OPEN ids left → **escalate** (step 6 with open items).

For each remaining disagreement, use **AskUserQuestion** — one decision per open
ID, stating your position, Codex's position, and the crux. Apply the user's
rulings to the plan and close those IDs.

## 6. Output

Finalise `<dir>/consensus-plan.md` in an **implementation-ready** shape — ordered
steps, the exact files each step touches, and how to validate each — then present it
inline and announce its path.

**Stop here. This skill plans; it does not implement** — not even an obvious
step. Offer the handoff explicitly and wait for the user's choice: implement now,
hand to `writing-plans` for a task-by-task plan, or cross-check with the
`critique` skill.

## Operational notes

- Keep prompts compact — round economy matters at `xhigh`; lean on session
  memory and file refs, never resend transcripts.
- Resume rounds wait for the reply (up to 540 s per call); a round that runs
  longer exits 10, and `wait <dir>` collects it.
- Fail fast: on exit 1 surface the envelope's `error`; do not silently retry or
  fabricate Codex's side.
- No cleanup needed — each run uses a unique directory; never `rm -rf` session dirs.
