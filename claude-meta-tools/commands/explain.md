---
description: Explain a concept, code pattern, or topic — the minimum that makes it understood, with a diagram only when it shows a mechanism
argument-hint: <topic>
allowed-tools:
  - Read
  - Glob
  - Grep
  - WebSearch
  - WebFetch
  - mcp__*
---

# Explain: $ARGUMENTS

Make the user genuinely understand the topic in the fewest words that do the job.

- Answer the question asked, not a template. No fixed sections, no mandatory analogy,
  no restating an idea already stated. Stop when the concept is understood — if the
  answer runs past roughly a screen, you are answering questions that weren't asked.
- If the topic touches this codebase, ground the explanation in the actual code and
  cite `file:line`. Otherwise explain from knowledge — but verify recent, contested,
  or precise factual claims (numbers, dates, attributions) with the research tools
  before asserting them. Name a verified source inline in the sentence that uses it;
  never append a sources section.
- Default to no diagram. Add at most one ASCII diagram (under 80 columns) only when
  it shows something simultaneous or branching that linear prose can't hold — a fork,
  a feedback loop, concurrent state. A diagram that restates the prose is noise.
- Define jargon inline the first time it appears, or don't use it.
- End with a single line naming 2-3 adjacent angles worth digging into, and let
  follow-up questions drive the depth. Never pre-empt them with the full tour.
