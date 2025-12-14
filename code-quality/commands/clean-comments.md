---
description: Remove useless comments from modified files
argument-hint: [file-pattern]
allowed-tools:
  - Read(*:*)
  - Edit(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - Bash(*:*)
model: claude-opus-4-5
---

# Clean Comments Command

Remove useless comments from files, keeping only meaningful ones.

<removal_criteria>
Remove comments that:
- Restate obvious code behavior (the code already says this)
- Are commented-out code blocks (use git history instead)
- Add no information beyond what the code expresses
- Are redundant with function/variable names
</removal_criteria>

<preservation_criteria>
Keep comments that:
- Explain non-obvious logic or algorithms
- Document magic numbers/constants with reasoning
- Define interfaces, types, or contracts for public APIs
- Provide important context not evident from code structure
- Are copyright headers or license blocks
</preservation_criteria>

<workflow>
1. **Identify files:**
   - Use `$ARGUMENTS` if provided, otherwise `git diff --name-only`
   - Focus on code files (js, ts, py, go, rs, java, etc.)

2. **Read files in parallel:**
   - Read multiple files simultaneously when possible
   - NEVER edit a file you haven't read first

3. **Evaluate each comment:**
   - Consider whether it adds value beyond the code itself
   - Prefer removal when uncertain—removing marginal comments
     costs little, but keeping noise accumulates technical debt

4. **Apply edits:**
   - Use Edit tool to remove useless comments only
   - Do NOT add new comments, refactor, or make other changes
   - Preserve formatting and structure

5. **Report results:**
   List files processed with comments removed vs kept counts
</workflow>

<guidelines>
- Be aggressive with removal—code should be self-documenting
- Never remove JSDoc/docstring API documentation for public interfaces
- Focus on inline comments and implementation details
- If a file has no useless comments, note it and move on
</guidelines>
