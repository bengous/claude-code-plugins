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

Remove all useless comments from files you've touched, keeping only meaningful ones.

## What Gets Removed

- Obvious comments that just restate the code
- Commented-out code
- Redundant documentation
- Noise comments that add no value

## What Gets Kept

- Explanations of non-trivial code logic
- Documentation of "magic" constants or numbers
- Interface/type/contract definitions
- Complex algorithm explanations
- Important architectural notes

## Instructions for Claude

**Your task:**

1. **Identify modified files:**
   - If `$ARGUMENTS` provided, use those file patterns
   - Otherwise, use `git diff --name-only` to find recently modified files
   - Focus on code files (js, ts, py, go, rs, java, etc.)

2. **For each file:**
   - Read the file content
   - Analyze each comment critically
   - Remove comments that are:
     - Restating obvious code behavior
     - Redundant or noise
     - Commented-out code blocks
   - Keep comments that:
     - Explain non-trivial logic or algorithms
     - Document magic numbers/constants with reasoning
     - Define interfaces, types, or contracts
     - Provide important context not evident from code

3. **Apply changes:**
   - Use the Edit tool to remove useless comments
   - Preserve all meaningful comments
   - Maintain code formatting and structure

4. **Report results:**
   - List files processed
   - Summarize comments removed vs kept
   - Highlight any files with no changes needed

**Guidelines:**
- Be aggressive with comment removal - code should be self-documenting
- When in doubt about a comment's value, prefer removal
- Never remove copyright headers, license blocks, or JSDoc/docstring API documentation for public interfaces
- Focus on inline comments and implementation details
