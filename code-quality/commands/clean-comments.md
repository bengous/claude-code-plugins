---
name: clean-comments
description: Remove useless comments from modified files. Use for code cleanup, comment audit, reducing comment noise, or cleaning up redundant documentation.
argument-hint: [file-pattern] [--propose]
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

## Mode Selection

Parse `$ARGUMENTS` to determine mode:
1. Check if `$ARGUMENTS` contains `--propose` (word boundary match, position-independent)
2. If present: **Proposal mode** — remove `--propose` from string, remainder is file pattern
3. Otherwise: **Direct mode** — entire `$ARGUMENTS` is file pattern (or empty)

**Examples:**
- `--propose src/*.ts` → Proposal mode, pattern: `src/*.ts`
- `src/*.ts --propose` → Proposal mode, pattern: `src/*.ts`
- `@src/file.ts --propose` → Proposal mode, pattern: `@src/file.ts`
- `src/*.ts` → Direct mode, pattern: `src/*.ts`
- (empty) → Direct mode, use `git diff --name-only`

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

<workflow_direct_mode>
## Direct Mode Workflow (default)

1. **Identify files:**
   - Use file pattern from arguments if provided, otherwise `git diff --name-only`
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
</workflow_direct_mode>

<workflow_proposal_mode>
## Proposal Mode Workflow (--propose)

1. **Identify and read files:**
   - Same as direct mode for file identification
   - Read all target files in parallel

2. **Analyze each comment:**
   For each comment, determine:
   - **REMOVE**: Why it should be removed (which removal criterion it violates)
   - **KEEP**: Why it should be kept (which preservation criterion it satisfies)
   - **REFACTOR**: If a comment could be eliminated by better naming or extraction

3. **Present proposal:**
   Group findings by file and present:
   ```
   ## [filename]

   ### Comments to REMOVE (N)
   - Line X: `// comment text` — Rationale: [why it should go]

   ### Comments to KEEP (N)
   - Line Y: `// comment text` — Rationale: [why it adds value]

   ### Refactoring Alternatives (optional)
   - Line Z: Instead of comment, consider renaming `foo` → `descriptiveName`
   - Line W: Extract to function `calculateTaxRate()` to make comment unnecessary
   ```

4. **Wait for approval:**
   Ask: "Proceed with comment removals? (Refactoring suggestions require separate confirmation)"
   - If approved: Execute comment removals only
   - If user also wants refactorings: Confirm each refactoring individually before executing
   - If declined: Ask what adjustments to make

5. **Execute approved changes:**
   Apply only the explicitly approved edits
</workflow_proposal_mode>

<edge_cases>
- **No matching files**: Report "No files match pattern '[pattern]'" and exit
- **No code files found**: Report "No code files to process" and exit
- **No comments found**: Report "No comments to evaluate in [N] files" — success with zero changes
- **Binary/non-text files**: Skip silently
- **Read errors**: Report which files couldn't be read, continue with others
</edge_cases>

<guidelines>
- Be aggressive with removal—code should be self-documenting
- Never remove JSDoc/docstring API documentation for public interfaces
- Focus on inline comments and implementation details
- If a file has no useless comments, note it and move on
- In proposal mode, provide clear rationales for each decision
- Refactoring suggestions are optional enhancements, not requirements
</guidelines>
