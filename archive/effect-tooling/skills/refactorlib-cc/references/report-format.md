# Exploration Report Format

Report each finding as a separate entry. Do not merge related findings into summaries.
The orchestrator will deduplicate and triage.

## Finding: <descriptive title>

- **file**: <absolute path>
- **lines**: <start>-<end>
- **what_it_does**: <1 sentence describing the custom code>
- **replacement**: <library API name and call signature>
- **replacement_source**: <which installed dependency provides this>
- **confidence**: high | medium | low
- **grep_pattern**: <the pattern that found this>
- **callers**: <number of files importing/using this code>

## Rules

- One entry per discrete piece of replaceable code
- Include exact file paths and line numbers -- no approximations
- Only recommend APIs from dependencies listed in "Project Dependencies"
- If confidence is "low", explain why in what_it_does
- Do not include implementation suggestions or refactored code
