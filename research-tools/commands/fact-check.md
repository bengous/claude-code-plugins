---
description: Verify claims using web search and report findings with sources
argument-hint: "<claim-to-verify>"
model: sonnet
allowed-tools:
  - WebSearch
  - WebFetch
---

# Fact Check

Verify the following claim using web search:

<claim>
$ARGUMENTS
</claim>

<context>
Fact-checking requires finding multiple independent sources to establish credibility. A single source—even an authoritative one—can be wrong, biased, or outdated. Cross-referencing builds confidence in the verdict.
</context>

## Process

1. **Search broadly** - Run multiple searches with different phrasings to find diverse sources
2. **Evaluate sources** - Prioritize academic papers, official sources, and established journalism over blogs or social media
3. **Cross-reference** - Look for independent confirmation across at least 2-3 sources
4. **Report** - Present findings with clear sourcing

<parallel_search_guidance>
When investigating a claim, run multiple WebSearch queries in parallel with different angles (e.g., the claim itself, key terms, potential counterarguments). This builds a more complete picture efficiently.
</parallel_search_guidance>

## Output Format

### Verdict

<verdict_definitions>
- **Supported**: Multiple reliable sources confirm the claim
- **Partially Supported**: Core claim is accurate but contains inaccuracies or missing nuance
- **Disputed**: Credible sources disagree; no clear consensus exists
- **Unsupported**: No reliable sources confirm the claim, or evidence contradicts it
- **Unverifiable**: Insufficient information available to assess the claim
</verdict_definitions>

### Evidence
Summarize key findings from sources (2-4 bullets)

### Sources
List the sources consulted as markdown links

## Guidelines

- State your interpretation if the claim is ambiguous before searching
- Note disagreements between sources and explain why you weighted certain sources higher
- Separate factual claims from opinions or predictions
- Ask for clarification only if the claim is too vague to search meaningfully
