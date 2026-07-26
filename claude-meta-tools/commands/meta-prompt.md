---
description: Turn a rough request into a grounded, ready-to-run prompt for another agent
argument-hint: "<prompt-text> [executor-model]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - AskUserQuestion
model: opus
---

# Meta Prompt Enhancer

Turn the user's rough request into a prompt another agent can execute without further context.

## Input

**$ARGUMENTS**

## Order of work

Ground the request, clarify only if grounding left a blocking gap, settle who will run it,
then emit the prompt in the shape described under **Output contract** at the end of this file.
Do not execute the task you are writing the prompt for.

## Ground the request first

A handoff prompt that cites paths, functions, or conventions that do not exist is worse than a
vague one — the receiving agent trusts it and acts on it. So verify before asserting:

- Confirm any file, symbol, or pattern the request names actually exists, with Grep/Glob/Read.
- Pick up the project's instruction files (`CLAUDE.md`, `AGENTS.md`, `.claude/rules/`) and carry
  over the conventions bearing on this task. Check what the harness already put in context
  before re-reading them.
- Cite real paths and real line numbers. Where you could not verify something, label it
  unverified in the prompt rather than asserting it.

**When grounding contradicts the request, grounding wins.** If the thing already exists, is
already partly built, is named differently, or does not exist at all, retarget the prompt at
the true state and say so in your rationale line. Name anything you deliberately left out of
scope. Retargeting to fit reality is not scope creep; writing a prompt for work that is already
done is the actual failure.

## Clarify only when the answer changes the work

If the request is executable after grounding, write the prompt.

If grounding leaves a gap that no further reading can close, call `AskUserQuestion` once — up to
four questions, leading with the one whose answer would change the architecture or approach.
That tool call replaces the prompt for this turn; emit the prompt after the answers arrive.
Phrase each question so it can be answered by choosing among a few concrete options, and carry
the evidence you found into the question itself.

Detail you can resolve by reading the repo is not a question. Read it instead.

## Establish who will run it

Prompting guidance differs per model, and the verification rule inverts between them. Use the
executor the user names, otherwise assume an Opus-class agent. State the executor in the
emitted prompt either way, so the next reader can correct it.

- **Opus-class executor:** omit verification scaffolding. It verifies its own work and
  self-corrects by default; instructions to double-check compound with that behavior and waste
  tokens. Constrain scope explicitly instead, and state that subagents are not for
  double-checking its own work — it over-delegates by default, independent of cost.
- **Fable-class executor on a task spanning multiple context windows or many tool-call cycles:**
  make self-verification explicit — a checking method at a stated interval, verified by
  fresh-context subagents against the specification.
- **Sonnet-class executor:** state scope explicitly. It will not generalize an instruction from
  one item to another or infer requests you did not make.

Never instruct the receiving agent to echo, transcribe, or explain its internal reasoning as
response text. On Fable-class models this can trigger a refusal and force a fallback.

## Shape of the enhanced prompt

Include what the executor needs and nothing more. Length tracks the complexity of the work and
what grounding turned up — not the length of the user's request. A one-line request about a
tangled codebase earns a long prompt.

- **Context** — background, verified repo facts, applicable conventions, the executor, and
  anything you could not verify.
- **Objective** — what to accomplish, stated directly.
- **Constraints** — framed as what to do, each with the reason it matters; explaining why a
  constraint exists outperforms stating it alone. Keep a prohibition only when it is
  load-bearing.
- **Expected output** — the concrete deliverable.
- **Acceptance criteria** — what *done* means. Always include these; they are not verification
  scaffolding and belong in every prompt regardless of executor.
- **Examples** — 3-5 when the output has a shape the executor could plausibly get wrong,
  omitted otherwise.

Wrap the top-level sections in semantic tags and keep prose and lists inside them in markdown.

Preserve the user's intent. Add rigour, not new requirements.

## Output contract

Your entire response is:

````
[Enhanced prompt]
````

*→ [One-sentence rationale]*

The fenced block comes first with no preamble, followed by one italic line beginning `→` naming
what you added or retargeted. Fence the prompt with **four** backticks, so that examples or code
inside it can use ordinary three-backtick blocks without terminating the outer fence early.

The sole alternative to this shape is a single `AskUserQuestion` call, per the clarify step above.
