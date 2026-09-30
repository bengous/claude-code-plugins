---
name: critique
description: Critical second opinion from Codex (OpenAI) on a proposal Claude just made — confirms what is sound, challenges what is genuinely weak, and suggests a better path with clear reasoning when one exists. Constructive, not contrarian. Use to cross-check a Claude design, refactor, API, or fix with a non-Claude model before acting on it.
argument-hint: [what to critique / extra focus]
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts *)
  - Read(~/.cache/agents-bridge/**)
  - Edit(~/.cache/agents-bridge/critique/**)
---

# Cross-model critique

A second pair of eyes from a non-Claude model (Codex) on a proposal
**Claude just made** — a design, refactor, API, or fix. Goal: a genuine
cross-model check. Validate what holds up, challenge what is weak, surface a
better path when one exists. Not a rubber stamp, not reflexive contrarianism.

## When to use

- Claude (this instance or another) proposed a solution and you want it
  pressure-tested before committing.
- You said "not bad, right?" and actually want the honest answer.
- A decision has real forks and one outside viewpoint would de-risk it.

NOT for reviewing local git changes — use `/agents-bridge:adversarial-review`.
It reads the **git diff**; a proposal usually lives in the conversation, not on
disk, so a diff-based review would miss it (and may review unrelated
working-tree files instead).

## Workflow

1. **Create the run directory.** Use the printed path literally in every later
   step: shell variables do not survive between Bash calls.

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" new critique
   ```

2. **Write the prompt — grounded** — to `<dir>/prompt.md` with the Write tool.
   Start it with the instruction block below, verbatim, then add: the proposal
   verbatim, the problem it solves, any constraints, the questions you most want
   challenged, an explicit list of the **real repo file paths** it touches or
   depends on, and — if the user gave extra focus with the invocation — a final
   `## Extra focus from the user` section carrying it verbatim. Grounding in
   actual code is the one thing that makes the critique useful; skip it and the
   review drifts into generic advice.

   ```markdown
   You are giving a CRITICAL SECOND OPINION on a proposal made by another AI
   (Claude), at the user's request. Read everything below, including any "Extra
   focus from the user" section, then read the real repo files it lists before
   judging. Then: (1) briefly confirm what is sound; (2) challenge only what is
   genuinely weak — correctness bugs, wrong assumptions, missed edge cases, or a
   simpler/safer/more idiomatic option — grounding every point in the actual
   code; (3) where a better path exists, describe it concretely and explain WHY
   (tradeoffs); (4) if it is good as-is, say so plainly and do not invent
   problems. End with a one-line verdict: SHIP / ADJUST / RECONSIDER.
   ```

3. **Run Codex read-only** (it is a review; it must not edit), from the
   repository the proposal is about:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" start <dir> --prompt-file <dir>/prompt.md --role audit
   ```

   Run each `codex-run.ts` command alone, as written: a `;`, `&&` or `echo $?` added to it asks for permission, and the envelope's `status` already gives the exit code.
   Exit 0 prints the verdict after the `--- final message ---` line. Exit 10
   means Codex is still working: run `"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" wait <dir>`
   until the exit code changes. Exit 1 is a failed run: report the envelope's
   `error` and show no verdict.

4. **Relay, then verify.** Surface Codex's verdict and reasoning. Then
   **independently check its claims** before acting — confirm a flagged bug is
   real, or push back if Codex is wrong. The value is two models reasoning in the
   open with Claude adjudicating, never Claude blindly deferring.

## Defaults & overrides

- Role `audit`, sandbox read-only. The user may name a model (`-m <slug>`) or
  an effort (`--effort <level>`); add it to the `start` command. A critique is
  adversarial reasoning work — don't downgrade the tier.
- To push back, write the objection to `<dir>/pushback-2.md` and resume the
  thread; resume replays the model, effort and sandbox of the first turn. The
  `allowed-tools` grant covers the invoking turn only, so a later turn may
  prompt:

  ```bash
  "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" resume <dir> --prompt-file <dir>/pushback-2.md
  ```
