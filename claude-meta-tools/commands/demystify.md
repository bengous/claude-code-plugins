---
description: Explain a complex concept to a smart layperson with analogies and progressive depth
argument-hint: <concept or topic>
allowed-tools:
  - WebSearch
  - WebFetch
  - mcp__exa__web_search_exa
  - mcp__exa__get_code_context_exa
  - mcp__Context7__resolve-library-id
  - mcp__Context7__query-docs
---

# Demystify: $ARGUMENTS

Use the **demystify** skill to explain this concept.

## Process

1. **Decide whether to research first.** If the topic is recent, contested, or you're less than 95% confident in the details, use available search tools to verify before explaining. For well-established, stable concepts, explain directly.

2. **Follow the progressive revelation structure** from the demystify skill:
   - One-sentence essence (no jargon)
   - The analogy (concrete, mechanism-mapping, with stated limitations)
   - How it actually works (real mechanism, terms defined inline)
   - Why it matters (human consequences)
   - The nuance (what the simplification hid, expert debates)
   - Going deeper (optional -- prerequisites and adjacent concepts)

3. **Calibrate to the topic.** Not every concept needs all six sections. A straightforward topic might need three. A deep one might need all six. Use judgment.

## Success Criteria

- A smart person in a different field could read this and genuinely understand the concept
- No jargon is used without inline definition
- At least one concrete analogy maps mechanism, not surface
- The nuance section honestly flags what was simplified
- Zero codebase references (no file paths, no line numbers, no repo-specific code)
