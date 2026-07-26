---
description: Audit prompts, commands, skills, and agent docs against current Claude prompting guidance
argument-hint: "<file-path or inline prompt> [target-model]"
allowed-tools:
  - Read
  - Glob
  - Grep
  - AskUserQuestion
disallowed-tools:
  - Write
  - Edit
model: opus
---

# Prompt Auditor

Grade a prompt against the guidance for the model that will actually run it.

## Input

**$ARGUMENTS**

## Step 1: Load the artifact

If the input looks like a file path (contains `/` or ends in `.md`), Read it. Otherwise treat
it as inline prompt text.

## Step 2: Load the guidance

Read `${CLAUDE_PLUGIN_ROOT}/references/claude-prompting-guidance.md`.

That variable is not always substituted in command text. If the path arrives unexpanded or does
not resolve, search for `claude-prompting-guidance.md` with Glob, or with whatever search tool
this session has, and read it from there — it sits at `references/` inside this plugin.

Do not fetch anything over the network. That file is the rubric: it carries a provenance header
with its sources and fetch date, and the audit depends on it.

## Step 3: Establish the target model

Prompting guidance now differs **per model**, and two of the models want opposite things on
verification. Settle the target before grading:

1. Use the target named in `$ARGUMENTS`, if any.
2. Otherwise read the artifact's `model:` frontmatter.
3. Otherwise assume **Opus-class** — the effective default for a skill, command, or bare prompt
   that names no model — and say so in the report. This is an assumption about the invoking
   session, not a fact about the artifact, so label it as one.

Ask via `AskUserQuestion` only when route 3 applies **and** the artifact *instructs its own
runner* to verify, self-check, or echo its reasoning. Those are the only axes where the targets
disagree, so anywhere else the assumption is harmless. An artifact that merely discusses
verification policy for other models — as a prompt-writing tool would — does not trigger this.

Also decide whether the artifact describes a **long-running** task — one spanning multiple
context windows or many tool-call cycles, such as a migration, a broad audit, or a
multi-hour agent. This single judgment flips the verification advice between targets, so state
your reading of it.

## Step 4: Grade

Score these eight dimensions. Rate each `strong`, `adequate`, `weak`, or `n/a` — text labels,
no emoji, no numeric scores.

1. **Clarity and directness** — would a competent colleague with no extra context execute this?
2. **Positive framing** — instructions stated as what to do. Load-bearing prohibitions are fine;
   flag scaffolding built entirely out of negations.
3. **Structure** — are the parts the model must distinguish (instructions, context, input,
   examples) separated so they cannot be confused, by semantic tags or by unambiguous sections?
   Plus style matching: where the prompt specifies a response format, does its own formatting
   demonstrate that format? A markdown command body that asks for tagged output is fine — style
   matching concerns the format the prompt *shows*, not the file it lives in.
4. **Examples** — 3-5 where the output has a shape the receiving agent could plausibly get
   wrong: a schema, a report layout, a code idiom to match. Rate `n/a` when the output shape is
   obvious or genuinely freeform. Do not penalize a command body *for having* examples — the
   count guidance is for task prompts. Noting a genuinely underdetermined output shape is fair.
5. **Tool-usage guidance** — expressive interfaces and explicit trigger conditions.
6. **Scope fit** — bounded task, stated boundaries, no unstated widening.
7. **Instruction economy** — the axis Claude-4-era prompts fail, and it cuts **both ways**:
   - *Surplus:* would the target do this unprompted? Covers verification scaffolding, re-check
     instructions, and over-prescription. Opus-class targets self-verify and self-correct, so
     that scaffolding is pure cost.
   - *Deficit:* is a required instruction **missing**? On a Fable-class target running a
     long-running task, absent self-verification is a defect, not a saving.
   Resolve the direction against the target's delta section before rating.
8. **Per-model fit** — behaviors specific to the target: Fable-class `reasoning_extraction`
   hazard and over-prescription sensitivity, Sonnet-class literalism at low effort, Opus-class
   scope expansion and over-delegation. Check explicitly for guidance the target *requires* and
   the artifact omits.

When a finding fits both 7 and 8, count it under 7 and rate 8 on what remains. Acceptance
criteria are never a dimension-7 surplus: a prompt stating what *done* means is correct on
every model.

Then run the **dead-mechanisms** check — a factual pass, not a judgment call. Check the artifact
against the `Dead mechanisms` table. Some rows are literal strings; others are prose conditions
you resolve by inspection. These are wrong rather than merely dated, so report them separately
from the graded dimensions.

## Step 5: Report

One table row per dimension, in the order above, using these names.

```
## Audit: [filename or "Inline Prompt"]

Target model: [model] ([named | from frontmatter | assumed Opus-class, with reason])
Long-running: [yes | no], [basis]

### Summary
[1-2 sentences]

### Dimensions
| Dimension | Rating | Notes |
|-----------|--------|-------|
| ... | strong/adequate/weak/n/a | ... |

### Dead mechanisms
[Each factually-wrong assertion with its line, and what is true instead. Say `none` when the
artifact is clean — a clean result is worth reporting.]

### Priority issues
1. **[Issue]**
   - Current: `[quote]` — or `absent`, naming where it should appear
   - Why it costs: [effect on this target model]
   - Fix: `[replacement, or the instruction to add]`
```

A missing instruction is a reportable finding. Use `absent` in the `Current` slot rather than
dropping it for lack of a quote.

## Step 6: Offer a revision

Use `AskUserQuestion`: full revision, priority fixes only, or none.

If the user wants one, emit the revised prompt inline, fenced with **four** backticks so any
three-backtick blocks inside it survive intact. This command does not write files — the caller
applies it.
