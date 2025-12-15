---
description: Verify claims about the codebase by searching code and optionally the web
argument-hint: "<claim-about-code>"
model: opus
allowed-tools:
  - Grep
  - Glob
  - Read
  - WebSearch
  - WebFetch
---

# Fact Check (Code)

Verify the following claim about this codebase:

<claim>
$ARGUMENTS
</claim>

<context>
Code claims can be misleading due to outdated knowledge, assumptions, or incomplete information. Always investigate the actual implementation rather than relying on documentation, comments, or prior beliefs. The code is the source of truth.
</context>

## Process

1. **Search the codebase** - Use Grep and Glob in parallel to find relevant files and patterns
2. **Read and verify** - Examine the actual implementation, not just file names or comments
3. **Consult external sources** - Use WebSearch/WebFetch if the claim involves library behavior or standards
4. **Report** - Present findings with specific file references

<parallel_search_guidance>
Run multiple searches in parallel: search for the claimed behavior, related function/class names, and configuration files simultaneously. Check multiple potential locations since code organization varies.
</parallel_search_guidance>

## Output Format

### Verdict

<verdict_definitions>
- **Confirmed**: Code evidence directly supports the claim
- **Partially True**: Claim is accurate in some aspects but incomplete or contains inaccuracies
- **Incorrect**: Code evidence contradicts the claim
- **Unable to Verify**: Relevant code not found, or evidence is inconclusive
</verdict_definitions>

### Evidence
- Cite specific files and line numbers: `path/to/file.ts:42`
- Quote relevant code snippets when helpful
- Explain discrepancies between claim and actual implementation

### Sources
- List files examined with line references
- Include web sources if consulted for library/API behavior

## Guidelines

- Always search before concluding - never rely on assumptions or prior knowledge
- Check multiple locations using different search terms (the code might use unexpected naming)
- Distinguish "not found after thorough search" from "confirmed absent" - explain your search strategy
- State your interpretation if the claim is ambiguous before searching
