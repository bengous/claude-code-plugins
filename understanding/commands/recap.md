---
description: Re-explain the last reply from zero, in layers, from the decision the user must take down to the steps. For when the user did not read a long reply.
argument-hint: "<nothing, a question, or one of: decisions | steps | diagram>"
disable-model-invocation: true
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Recap

The user did not read the last reply. Assume nothing from it reached them. Do not shorten it, do not
apologise for its length, and do not ask what confused them. Rebuild the picture from zero, so the
user can decide without reading the original.

## Input

**$ARGUMENTS**

- Nothing: explain the last reply.
- A question: answer it from the last reply, then give layer 1 only.
- `decisions`: layer 1 only.
- `steps`: layers 1 and 3.
- `diagram`: layer 1, then layer 2 as a Mermaid diagram, nothing else.

"The last reply" is the most recent assistant turn before this command. When that turn is a tool
result or a one-liner, go back to the last turn with substance. When no turn has substance, say so
and stop. When the reply reports on files, read them with Read, Grep or Glob before you explain; do
not explain from memory. Nothing here changes a file or starts work.

## Layer 1: what the user must do

Open with the decision, in one or two sentences. Name the one question only the user can settle, or
say that nothing waits for them. If the reply ended with a request for approval, state it again here,
with the recommended answer and what it costs if wrong.

Then list what changed in the world: files written, commands run, tests passed or failed, anything
sent outside the repo. Facts only, no narrative.

## Layer 2: the shape of what happened

Explain the reply as a system, not as a story. Pick the representation that fits the content:

- A change to code or behaviour: pseudocode of the new logic, or a call tree from the entry point to
  what changed.
- A flow, a pipeline, a sequence of actors: a Mermaid diagram, with the changed part marked.
- A comparison or a set of options: a table, recommended option first.
- Plain reasoning: three to five sentences, each one idea.

One representation. Do not add a second one to be safe. Use the same names the code uses.

## Layer 3: the steps

Number what the reply did, in the order it did it, one bounded action per step. For each step, say
what it touched and what checked it (a test, a command output, nothing). Mark any step the reply
claimed without evidence.

End with what is still open: errors left, assumptions the reply made, anything it skipped and said so.

## Rules

- Write in the user's language, in the active voice, with short sentences. The output style governs
  the prose; this skill governs the order.
- Each layer stands alone. The user may stop after layer 1.
- Never invent a decision to fill layer 1. "Nothing waits for you" is a valid layer 1.
- Never paraphrase an error message, a path or a command. Quote them.
- When the last reply was itself wrong or incomplete, say so in layer 1, before the decision.
