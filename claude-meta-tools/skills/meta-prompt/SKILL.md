---
name: meta-prompt
description: Turn a rough request or the preceding conversation into a clean prompt for another agent, carrying the user's intention at the user's level of certainty. Use when the user asks to write a prompt, meta-prompt, briefing, or handoff for a separate agent session, or wants to delegate a task just discussed to a fresh instance.
argument-hint: "<rough request>"
allowed-tools: Read, Grep, Glob
---

# Meta Prompt

Write the prompt another agent will receive. The prompt carries the user's intention, at the
user's level of certainty. It is not a plan.

## Input

**$ARGUMENTS**

No arguments: the request is the task discussed in this conversation.

## Preserve intention and certainty

The executor treats everything in the prompt as the user's own words. So nothing enters the
prompt that the user did not decide.

- A directive the user stated ("use this lib", "do it like X", "not in that file") is kept as
  a directive, in the user's terms.
- Everything the user left open stays open. Never pick an approach, a library, a file layout,
  a sequence of steps, or a scope the user did not pick. Never add requirements, acceptance
  criteria, or examples the user did not give.
- When the request reads as exploration (confused ideas, "I'm not sure", "let's think
  about"), say so in the prompt: the executor is to think it through with the user before
  implementing.
- Questions go into the prompt, under **Open**, for the executor to ask. Do not ask them here.

## Mine the conversation

When the request follows a discussion, the conversation holds facts the executor needs:
decisions made and why, constraints and anti-patterns the user expressed, prior art they
pointed at. Carry those in, filtered to what bears on the task. The executor reads cold: no
shorthand from this conversation ("as discussed", "the earlier approach"). Every reference
resolves for a reader with zero context.

## Verify references

Check that each file, symbol, or convention the request names exists. Pick up the
conventions in `CLAUDE.md`, `AGENTS.md`, and `.claude/rules/` that bear on the task, unless
the harness already put them in context.

Report what you found as facts: "exists at path", "does not exist", "already done in
path", "unverified". When the repo contradicts the request, state the contradiction under
**Context** and keep the request as the user made it. Retargeting is the executor's
conversation with the user, not yours.

## Clean the language

Full sentences, no verbal tics, no filler, same content. When the user's request is already
clear, the cleaned request is most of the output.

Do not execute the task you are writing the prompt for.

## Output

Your entire response is the prompt: the user pastes it into another session as-is, so no
preamble, no fence, no rationale, no closing line. Sections in this order, each omitted when empty:

**Request** — the cleaned request, in the user's words as far as they were clear.

**Decided** — the user's explicit directives, quoted.

**Open** — what the user left undecided or wants to explore, and what the executor should
ask or think through with the user before acting.

**Context** — what the executor cannot recover on its own: facts from the conversation, the
existence checks for what the request names, the conventions that bear on the task. Label
anything unverified. Do not investigate the task itself; that is the executor's work.
