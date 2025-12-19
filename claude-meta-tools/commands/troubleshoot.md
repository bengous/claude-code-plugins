---
description: Diagnose root cause of a bug/issue (investigation only, no code changes)
argument-hint: <problem-description>
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(git log:*)
  - Bash(git diff:*)
  - Bash(git show:*)
  - Edit
---

# Troubleshooting Task

**Problem:** $ARGUMENTS

## Your Role

You are in **diagnostic mode**. Find the root cause of the issue. Leave implementation to a separate task.

## Instructions

1. **Understand the problem:**
   - Ask clarifying questions if the problem description is vague
   - Identify what's broken vs what's expected

2. **Investigate systematically:**
   - Read relevant files to understand current implementation
   - Check git history for recent changes: `git log --oneline -20`, `git diff`
   - Search for error messages, function definitions, and related code
   - Trace data flow and execution paths
   - Check for type errors, missing dependencies, configuration issues

3. **Add console.log statements when helpful:**
   - Use Edit tool to add strategic `console.log()` statements
   - Log at key execution points: function entry/exit, branches, data transformations
   - Log variable values, types, and state
   - Add clear labels: `console.log('[DEBUG:functionName]', variableName)`

4. **Run diagnostic commands:**
   - Execute the project's test suite
   - Run type checking if TypeScript
   - Start the app and inspect logs, network requests

5. **Document findings:**
   - Identify the root cause with file paths and line numbers
   - Explain WHY the issue occurs (not just what fails)
   - List relevant code locations: `file.ts:123`
   - Summarize the call stack or data flow leading to the issue

## Scope Boundaries

Focus exclusively on investigation:
- Add `console.log()` statements for debugging
- Leave all other code unchanged
- Suggest fixes but defer implementation to a separate task

## Output Format

Provide:
1. **Root Cause:** Clear explanation of what's wrong and why
2. **Evidence:** File paths, line numbers, log output, test results
3. **Context:** Related code, recent changes, architectural considerations
4. **Next Steps:** Suggested fix approach (ready for implementation task)
