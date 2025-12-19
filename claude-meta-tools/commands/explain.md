---
description: Explain a concept, code pattern, or topic in detail
argument-hint: <topic>
allowed-tools:
  - Read
  - Glob
  - Grep
  - WebSearch
  - WebFetch
  - mcp__*
---

# Explanation Request

**Topic:** $ARGUMENTS

## Your Task

Provide a clear, thorough explanation of the requested topic.

## Instructions

1. **Understand the context:**
   - Search the codebase for relevant implementations
   - Check existing documentation and comments
   - Look for related patterns or usages

2. **Provide a structured explanation:**
   - **What it is:** Define the concept/pattern/code
   - **Why it exists:** Purpose and motivation
   - **How it works:** Implementation details with code references
   - **Where it's used:** Specific locations in the codebase (file:line)
   - **Related concepts:** Connected patterns or dependencies

3. **Include examples:**
   - Show actual code from the repository
   - Demonstrate usage patterns
   - Highlight key points with file references

4. **Be thorough but concise:**
   - Cover all important aspects
   - Skip obvious or trivial details
   - Link to relevant documentation if available

## Output Format

Structure your explanation with clear sections and include file paths with line numbers for code references (e.g., `src/auth/actions.ts:42`).

## Success Criteria

The explanation is complete when:
- The concept is clearly defined
- At least one concrete code example is shown
- File locations are provided for further exploration
