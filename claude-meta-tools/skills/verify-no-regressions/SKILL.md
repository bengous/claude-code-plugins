---
name: verify-no-regressions
argument-hint: "[count] [base-branch]"
description: >
  Verify no behavioral regressions after implementation. Spawns parallel sonnet
  subagents for semantic diff review + test execution. Use when: user says
  "verify no regressions", "check for regressions", "make sure nothing broke".
---

# Verify No Regressions

Usage: `/verify-no-regressions [count] [base-branch]` (defaults: 1 main)

## Work state

- Working tree: !`git status --short 2>/dev/null || echo "(not a git repo)"`
- Commits ahead of base: !`set -- $ARGUMENTS; git log --oneline "${2:-main}"...HEAD 2>/dev/null || echo "(none or invalid base)"`
- Committed diff: !`set -- $ARGUMENTS; git diff --stat "${2:-main}"...HEAD 2>/dev/null`
- Staged diff: !`git diff --cached --stat 2>/dev/null`
- Unstaged diff: !`git diff --stat 2>/dev/null`
- Test scripts: !`cat package.json 2>/dev/null | jq -r '.scripts | to_entries[] | select(.key | test("test";"i")) | "\(.key): \(.value)"' 2>/dev/null || echo "(no package.json)"`

## Instructions

Read the work state above to determine what happened:
- **Committed**: commits ahead of base, clean working tree → review with `git diff base...HEAD`
- **Staged**: files in staging → review with `git diff --cached`
- **Unstaged/untracked**: modified or new files → review working tree files directly
- **Mixed**: combination of the above → review all layers

If nothing changed anywhere, report that and stop.

Spawn **sonnet** subagents in a **single message**. Tell each agent which diff commands to use based on the work state.

1. **Semantic reviewers** -- split changed files across `$0` agent(s) (default: 1). Each agent:
   - Reads the diff (using the appropriate command for the work state) and current file contents
   - Classifies each change as INTENTIONAL, RISKY (could break callers), or REGRESSION
   - Reports verdict: PASS / NEEDS_REVIEW / FAIL

2. **Test runner** (skip if no test infrastructure) -- one additional agent that runs the test suite and reports PASS / FAIL.

After all agents complete, synthesize a single report with overall verdict.
