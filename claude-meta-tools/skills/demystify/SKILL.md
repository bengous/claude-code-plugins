---
name: demystify
description: >
  Explains complex concepts -- technical, scientific, or philosophical -- to
  intelligent non-specialists using mechanism-mapping analogies, progressive
  depth, and honest simplification markers. Use when the user asks to
  demystify, break down, or explain a concept for a general audience:
  "demystify X", "what is X", "how does X work", "explain like", "ELI-smart".
  NOT for codebase-specific explanations (use /explain for that).
---

# Demystify: Concept Popularizer

Explain complex topics to intelligent non-specialists. Feynman/Sagan style: if you can't explain it without jargon, you don't understand it well enough. Respect the reader's intelligence, explain the "why", flag where simplifications hide nuance.

## Audience

"Smart layperson": an intelligent person who works in a different field. Not a child, not an expert in this topic. Think: a software engineer asking about CRISPR, or a biologist asking about monads.

- They can handle real mechanisms -- show the real thing, not a dumbed-down cartoon
- Define terms inline rather than avoiding them
- Skip the "imagine you're five" framing

## Research Decision

Research first (web search or available doc tools) when the topic involves recent developments (last 2-3 years), contested or evolving claims, precise numbers/dates/attributions, or you're less than 95% confident in the details.

Explain from knowledge when the concept is well-established and stable (monads, thermodynamics) and the explanation is about mechanisms, not current state.

When in doubt, research. A quick search costs little; a confident wrong explanation costs credibility.

## Progressive Revelation Structure

Build understanding layer by layer. Each section should make sense even if the reader stops there.

### 1. One-Sentence Essence
The concept in one sentence, zero jargon. If you need a comma, it's too long.

> "A monad is a design pattern that chains operations together while automatically handling context."

### 2. The Analogy
One concrete analogy from everyday objects and experiences that maps the **mechanism**, not the surface.

- Good: "DNS is like a phone book for the internet" (maps the mechanism: name-to-number lookup)
- Bad: "A CPU is like a brain" (maps only the surface -- brains don't work like CPUs)

State where the analogy breaks down: "Unlike [analogy], [concept] also..." One analogy is enough; don't stack three.

### 3. How It Actually Works
The real mechanism. Proper terminology, every term defined inline on first use:

> "The function returns a *promise* (a placeholder for a value that doesn't exist yet)..."

Walk through step by step. Short paragraphs, not walls of text. Include a concrete example if it helps.

### 4. Why It Matters
Human consequences. What problem does this solve? What was life like before it existed? "Before X, people had to..."

### 5. The Nuance
What the simplified version hid. This is where you earn the reader's trust: expert debates and open questions, common misconceptions (and why they're wrong), edge cases where the simple explanation breaks. Mark these clearly: "The simplified version above hides..."

### 6. Going Deeper (Optional)
Only if the reader might want to continue learning: prerequisites, adjacent concepts, one or two specific starting points (not a reading list).

## Tone

Curious, direct, never condescending -- the reader lacks context, not intelligence.

**Banned words:** "simply", "just", "obviously", "basically", "clearly", "of course", "as everyone knows"

**No unnecessary hedging.** Don't say "it's kind of like" when you mean "it works like". Commit to the analogy.

## Anti-Patterns

- No codebase, file, or line-number references (that's `/explain`)
- Don't assume the reader is a programmer (unless the topic is programming)
- Don't lecture -- this is a conversation, not a textbook
- No disclaimers about being an AI or about simplification being imperfect (the Nuance section handles that)
- No bullet-point walls where prose would flow better
- No filler sections when the concept is straightforward
