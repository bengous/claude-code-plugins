<!-- source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md
             + prompting-claude-{opus-5,fable-5,sonnet-5}.md
             + https://code.claude.com/docs/en/{skills,slash-commands,model-config}.md
             + https://platform.claude.com/docs/en/build-with-claude/effort.md
     fetched: 2026-07-26
     targets: Claude Fable 5, Mythos 5, Opus 5, Sonnet 5, Haiku 4.5
     refresh: resolve current slugs via https://platform.claude.com/llms.txt
              (the page name is generation-agnostic and has been renamed once already;
               do not hardcode a versioned slug) -->

# Prompting guidance for current Claude models

Audit rubric distilled from the sources above. Keep this file under ~200 lines: a rubric
that sprawls contradicts the lesson it teaches.

**The headline change from Claude-4-era guidance is subtractive.** Current models do by
default much of what older prompts spell out, and spelling it out anyway costs tokens and
can degrade output. Anthropic's context-engineering blog reports removing over 80% of
Claude Code's system prompt for Opus 5 and Fable 5 with no measurable loss on their coding
evals — that figure is blog-sourced, not documentation, but the direction is corroborated
by the per-model docs cited below.

**Guidance is now per-model.** Opus 5 and Fable 5 want *opposite* things on verification.
An audit that does not establish its target model will give wrong advice half the time.

---

## Durable principles

These survive from the Claude-4 era unchanged. Verified against the current docs.

- **Be clear and direct.** State the task, the role, and what done means. Apply the
  golden-rule test: could a competent colleague with no extra context execute this?
- **Positive framing.** "Tell Claude what to do instead of what not to do" is still
  verbatim in the docs. This is a technique, not a ban — a load-bearing prohibition
  ("do not execute the task, only plan it") is fine. The target is redundant
  scaffolding built entirely out of negations.
- **Add context and motivation.** Explaining *why* a constraint matters outperforms
  stating the constraint alone.
- **Role prompting.** Still effective; assign a specific expert role.
- **Complete specification up front.** Opus 5 "performs best when given the complete
  task specification up front and left to run."
- **Long-context ordering.** Longform data near the top, the query at the end.
- **Structure with XML tags.** Still canonical: "Wrapping each type of content in its
  own tag (for example, `<instructions>`, `<context>`, `<input>`) reduces
  misinterpretation." One Anthropic marketing blog downplays XML; it also still
  recommends prefill, which now returns 400. Prefer the docs.
- **Examples: 3-5 for task prompts.** "Include 3-5 examples for best results," wrapped
  in `<example>`/`<examples>`, relevant and diverse. Note the count went *up* from the
  old "1-3" advice.
  - Caveat for command and skill bodies: the claim that examples "constrain the model to
    a certain exploration space" is blog-sourced and stated about *tool-usage* examples.
    Judge examples in a command body case-by-case. Do not flag them systematically.

## Output and formatting

- **Style matching (new).** "The formatting style used in your prompt may influence
  Claude's response style" — markdown in the prompt begets markdown in the output, and
  removing it reduces markdown in the response. Match prompt formatting to desired output.
- **Prompt for length explicitly.** On Opus 5 the effort parameter controls how much the
  model *thinks*, not how much it *says*. Lowering effort does not reliably shorten the
  visible response.
- **Calibrate written deliverables separately** from conversational verbosity. Files
  Claude writes to disk run long on Opus 5 unless told otherwise.
- **Prefill is gone.** Prefilled assistant messages return 400 on Claude 4.6+. Use
  structured outputs instead.

## Tool use

- Design expressive tool interfaces and parameters rather than teaching usage through
  examples in the description.
- Be explicit about when and how to use a tool, and why. If a model under-uses a tool,
  describe the trigger conditions rather than adding more examples.
- Effort drives tool usage: `high`/`xhigh` show substantially more tool use in agentic
  search and coding. With thinking disabled, Sonnet 5 reaches for tools less readily and
  needs an explicit nudge.

## Thinking and effort

- **`effort` is the budget dial:** `low`, `medium`, `high`, `xhigh`, `max`. Default is
  `high` on every model that supports it, except Opus 4.7 which defaults to `xhigh`.
- **Thinking defaults:** on by default for Opus 5 and Sonnet 5 when the `thinking`
  parameter is omitted; **always on and unmodifiable** for Fable 5 and Mythos 5.
- **Prefer thinking-on at low effort over thinking-disabled.** For most tasks, thinking
  enabled at `low` beats thinking disabled at comparable cost, and disabling thinking
  can leak tool calls as text or internal XML tags into visible output.
- **Changing `effort` between requests invalidates prompt caching.** Hold it constant
  within a cached conversation.
- In Claude Code, `effort` and `model` are valid frontmatter on both skills and files
  under `commands/` — they work the same way.

## Agentic and long-horizon work

- State files, checkpoints, and git-as-state all still apply for work spanning context
  windows.
- Prefer starting a fresh context window over compaction. Tell the model compaction is
  automatic so it does not wrap up early.
- Cap subagent delegation explicitly when cost matters. Delegation pays off on genuinely
  independent, sizeable tracks and wastes tokens on small ones.
- Constrain scope explicitly for narrow tasks; current models expand scope on their own
  more readily than prior ones.

---

## Per-model deltas

Establish the target model before applying these. They conflict with each other by design.

### Opus 5 — remove verification scaffolding

- **Remove explicit verification instructions.** "If your prompt contains explicit
  verification instructions ('include a final verification step for any non-trivial
  task,' 'use a subagent to verify'), remove them: instructions like these cause
  over-verification on Claude Opus 5, and removing them reduces wasted tokens with no
  loss in quality. The same applies to legacy harness scaffolding that adds separate
  verification steps."
- **Remove re-check instructions** — "double-check your answer," "re-verify before
  responding." The model self-corrects without prompting; these compound and add cost.
- **Do not let it verify via subagents.** It over-delegates; instruct that subagents are
  not for double-checking its own work.
- Constrain scope for narrow tasks. Prompt for response length and correction-narration
  restraint in user-facing products.
- Acceptance criteria are **not** verification scaffolding. What-done-means always stays.

### Fable 5 — the opposite on verification, plus a refusal hazard

- **Make self-verification explicit in long-run prompts.** "Separate, fresh-context
  verifier subagents tend to outperform self-critique." The docs give the pattern:
  establish a checking method at an interval and verify against the specification.
  The docs do not bound "long-run"; read it as spanning multiple context windows or many
  tool-call cycles — a migration, a broad audit, a multi-hour agent. This judgment is what
  flips the verification advice between Opus-class and Fable-class, so make it consciously.
- **Never instruct it to reproduce its reasoning.** Prompts or skills telling the model
  to echo, transcribe, or explain its internal reasoning as response text can trigger the
  `reasoning_extraction` refusal category, causing elevated fallbacks to Opus 4.8. Read
  structured `thinking` blocks instead. This is a functional hazard, not a style note.
- **Prior-generation skills are often too prescriptive** for Fable 5 "and can degrade
  output quality." Consider removing older instructions and measuring the default.
- Give the reason, not only the request. State boundaries. Ground progress claims.
- Do not surface remaining-token counts — it triggers premature wrap-up.

### Sonnet 5 — literal, especially at low effort

- **It does not silently generalize.** "If you need Claude to apply an instruction
  broadly, state the scope explicitly." Literalism is the upside for tuned pipelines and
  structured extraction, but implied scope will not be inferred.
- Remove forced interim-status scaffolding ("after every 3 tool calls, summarize
  progress") — it already gives regular updates.

---

## Dead mechanisms

Mechanical staleness check. Any prompt asserting these is factually wrong, not merely
dated.

| Assertion in the prompt | Reality |
|---|---|
| `think` / `think hard` / `think harder` / `think more` allocate thinking budget | Not keywords. "Passed through as ordinary prompt text." |
| `ultrathink` sets maximum thinking budget | It is recognized, but it adds an in-context instruction and "the effort level sent to the API is unchanged." Not a budget dial. |
| `budget_tokens` caps thinking | Returns **400** on Claude 4.7+. Deprecated on 4.6. Use adaptive thinking plus `effort`. |
| Prefill the assistant turn to steer format | Returns **400** on Claude 4.6+. |
| Workarounds that avoid or replace the word "think" | Premised on thinking being disabled. Fable 5 and Mythos 5 are thinking-always-on. |
| The subagent-spawning tool is named `Task` | It is `Agent`. Note that `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` are real and unrelated — do not match a bare "Task". |
| Pinned prior-generation model IDs in self-knowledge boilerplate | Current IDs: `claude-fable-5`, `claude-mythos-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`. Prefer abstract aliases in frontmatter. |
