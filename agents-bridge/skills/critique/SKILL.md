---
name: critique
description: Critical second opinion from Codex (gpt-5.5) on a proposal Claude just made — confirms what is sound, challenges what is genuinely weak, and suggests a better path with clear reasoning when one exists. Constructive, not contrarian. Use to cross-check a Claude design, refactor, API, or fix with a non-Claude model before acting on it.
argument-hint: [what to critique / extra focus]
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
  - Write(*:*)
---

# Cross-model critique

A second pair of eyes from a non-Claude model (Codex / gpt-5.5) on a proposal
**Claude just made** — a design, refactor, API, or fix. Goal: a genuine
cross-model check. Validate what holds up, challenge what is weak, surface a
better path when one exists. Not a rubber stamp, not reflexive contrarianism.

## When to use

- Claude (this instance or another) proposed a solution and you want it
  pressure-tested before committing.
- You said "not bad, right?" and actually want the honest answer.
- A decision has real forks and one outside viewpoint would de-risk it.

NOT for reviewing committed code against a diff — use `/codex:review` or
`/codex:adversarial-review`. Those read the **git diff**; a proposal usually
lives in the conversation, not on disk, so a diff-based review would miss it
(and may review unrelated working-tree files instead).

## Workflow

1. **Capture the proposal — grounded.** Write to one temp file: the proposal
   verbatim, the problem it solves, any constraints, the questions you most want
   challenged, and an explicit list of the **real repo file paths** it touches or
   depends on. Grounding in actual code is the one thing that makes the critique
   useful; skip it and the review drifts into generic advice.

   `Write /tmp/critique-proposal.md`

2. **Run Codex read-only** (it is a review; it must not edit). Keep the inline
   prompt short — the substance is in the file:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec \
     -s read-only \
     -c model_reasoning_effort=xhigh \
     "You are giving a CRITICAL SECOND OPINION on a proposal made by another AI (Claude), at the user's request. Read /tmp/critique-proposal.md in full, then read the real repo files it lists before judging. Then: (1) briefly confirm what is sound; (2) challenge only what is genuinely weak — correctness bugs, wrong assumptions, missed edge cases, or a simpler/safer/more idiomatic option — grounding every point in the actual code; (3) where a better path exists, describe it concretely and explain WHY (tradeoffs); (4) if it is good as-is, say so plainly and do not invent problems. End with a one-line verdict: SHIP / ADJUST / RECONSIDER. Extra focus from the user: $ARGUMENTS"
   ```

3. **Relay, then verify.** Surface Codex's verdict and reasoning. Then
   **independently check its claims** before acting — confirm a flagged bug is
   real, or push back if Codex is wrong. The value is two models reasoning in the
   open with Claude adjudicating, never Claude blindly deferring.

## Defaults & overrides

- Model `gpt-5.5`, effort `xhigh`, sandbox `read-only`. Override with codex flags
  (`-m <model>`, `-c model_reasoning_effort=<level>`) if the user asks.
- Capture the session id from the run header to push back:
  `"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec resume <SESSION_ID> "..."`.
- Each `exec` prints the active model / effort in its header — read it to confirm.

## Why a file, not an inline prompt

Proposals carry quotes, backticks, parentheses, apostrophes — passing them inline
through the shell breaks. Put the proposal and the file paths in the temp file;
keep the shell prompt a short pointer to it.
