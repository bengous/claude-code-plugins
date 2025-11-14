---
name: layer-testing
description: |
  Generate comprehensive tests for architectural layers with isolated worktrees.
  Use when the user wants to test a specific layer (core, domain, application, infrastructure, boundary)
  in a modular codebase. Reads project-specific testing strategy from .claude/testing-strategy.md.
  Handles worktree creation, agent delegation, and quality verification.
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - Task(*:*)
  - TodoWrite(*:*)
model: sonnet
---

# Layer Testing Skill

Test architectural layers systematically with worktree isolation and specialized testing agents.

## Purpose

This skill provides automated, comprehensive testing for modular architectures:
- Creates isolated worktrees for safe parallel work
- Delegates to specialized testing agents
- Enforces quality gates
- Provides structured feedback and recommendations

## When to Use

Activate this skill when:
- User wants to test a specific layer (core, domain, application, infrastructure, boundary, etc.)
- Project has modular architecture (hexagonal, clean, layered, custom)
- Need isolated testing environment to avoid conflicts
- Want comprehensive coverage with automated quality verification

**Example trigger phrases:**
- "Test the core layer of the auth module"
- "I need tests for the application layer"
- "Generate tests for infrastructure layer with 80% coverage"
- "Test photoshoot/domain layer"

## Prerequisites

### Required: Testing Strategy File

This skill requires a `.claude/testing-strategy.md` file in the project root that defines:
- Layer types and coverage targets
- What to test vs skip for each layer
- Testing patterns and frameworks
- Architecture-specific rules

**If missing**, suggest running: `/setup-testing-strategy`

**Why required**: Different projects have different architectures (hexagonal, clean, layered, custom). The strategy file acts as the "testing ideology" for your specific project, making this skill architecture-agnostic.

### Optional: Git Repository

Project should be a git repository for worktree management. If not, the skill can still analyze and provide testing guidance without worktree isolation.

---

## Workflow Overview

The skill follows a 4-phase workflow:

### Phase 1: Strategy & Analysis
- Read and validate `.claude/testing-strategy.md`
- Parse arguments (module, layer, coverage override)
- Scan target layer directory
- Categorize files (testable vs skip based on strategy)
- Calculate metrics (LOC, current coverage, gap)
- Present analysis and get user approval

### Phase 2: Execute
- Create isolated worktree (branch: `test/{module}-{layer}-coverage`)
- Spawn testing specialist agent with:
  - Testing strategy from Phase 1
  - File list and categorization
  - Worktree path and branch
  - Coverage target
- Agent works autonomously in isolation
- Wait for agent completion

### Phase 3: Review
- Verify agent results against quality gates
- Check coverage achieved vs target
- Verify zero production code changes
- Validate all tests passing
- Present comprehensive summary

### Phase 4: Next Steps
- Calculate overall module progress
- Recommend next layer to test (if applicable)
- Provide merge instructions
- Suggest follow-up actions

---

## Detailed Instructions

### Phase 1: Strategy & Analysis

**Step 1: Create TodoWrite**

Immediately create TodoWrite to track progress:
```
- Phase 1: Strategy & Analysis
- Phase 2: Execute
- Phase 3: Review
- Phase 4: Next Steps
```

Mark Phase 1 as in_progress.

**Step 2: Read Testing Strategy**

Read `.claude/testing-strategy.md`:

```bash
cat .claude/testing-strategy.md
```

If file doesn't exist:
```
❌ Testing strategy file not found

The layer-testing skill requires a testing strategy file to understand
your project's architecture and testing approach.

Run: /setup-testing-strategy

This will interactively create .claude/testing-strategy.md for your project.
```

STOP if strategy file missing. DO NOT proceed.

**Step 3: Parse Arguments**

Expected arguments:
- `MODULE`: Module name (e.g., "auth", "photoshoot", "user")
- `LAYER`: Layer name (e.g., "core", "domain", "application", "infrastructure", "boundary")
- `--coverage <percent>`: Optional coverage target override (default from strategy file)

Extract coverage target:
1. Check for `--coverage` flag in arguments
2. If present, use that value
3. Otherwise, look up default in strategy file for this layer type
4. If not found in strategy, use sensible default (70%)

**Step 4: Verify Structure**

Check that the target layer exists:

```bash
ls -la src/modules/${MODULE}/${LAYER}/ 2>/dev/null || \
ls -la src/${MODULE}/${LAYER}/ 2>/dev/null || \
find . -type d -path "*/${MODULE}/*/${LAYER}" -o -path "*/${MODULE}/${LAYER}" 2>/dev/null
```

If not found:
```
❌ Layer not found: ${MODULE}/${LAYER}

Available modules:
[list directories matching pattern from strategy file]

For ${MODULE}, available layers:
[list subdirectories]
```

STOP and report error if layer doesn't exist.

**Step 5: Analyze Files**

Scan the layer directory and categorize files based on the testing strategy:

Use Glob to find all files:
```bash
find src/modules/${MODULE}/${LAYER} -name "*.ts" -o -name "*.tsx" -o -name "*.js"
```

For each file, determine:
- **Testable**: Matches "what to test" patterns from strategy
- **Skip**: Matches "what to skip" patterns from strategy (events, types, re-exports, existing mocks, tests)

Calculate:
- Total files count
- Total LOC (use `wc -l`)
- Testable files count
- Skip files count

Check for existing tests:
```bash
find src/modules/${MODULE}/${LAYER} -name "*.test.*" -o -path "*/__tests__/*"
```

If tests exist, attempt to get coverage (framework-specific):
```bash
# Example for Vitest
pnpm test src/modules/${MODULE}/${LAYER} --coverage --reporter=json 2>/dev/null
```

**Step 6: Present Analysis**

Show user a comprehensive analysis:

```
📊 Analysis Complete: ${MODULE}/${LAYER}

Layer Type: [from strategy]
Coverage Target: ${COVERAGE_TARGET}%

Files to Test: ${TESTABLE_COUNT} files (${TESTABLE_LOC} lines)
Files to Skip: ${SKIP_COUNT} files (${SKIP_LOC} lines)

Current Coverage: ${CURRENT_COVERAGE}% (if available, otherwise "N/A - no tests exist")
Target Coverage: ${COVERAGE_TARGET}%
Gap: ${GAP}%

Testable Files:
  ✅ File1.ts (${LOC} lines) - [reason from strategy]
  ✅ File2.ts (${LOC} lines) - [reason from strategy]
  ...

Skipped Files:
  ❌ File3.ts - [reason from strategy, e.g., "events (no logic)"]
  ❌ File4.ts - [reason from strategy, e.g., "type definitions"]
  ...

Estimated effort: [based on LOC and current coverage]

Ready to proceed?
```

**Step 7: Get User Approval**

Wait for user confirmation before creating worktree.

If user declines, mark Phase 1 complete and exit gracefully.

---

### Phase 2: Execute

**Mark Phase 2 as in_progress** in TodoWrite.

**Step 1: Determine Repository Root**

```bash
REPO=$(git rev-parse --show-toplevel 2>/dev/null)
```

If not a git repository:
```
⚠️ Not a git repository - proceeding without worktree isolation

Tests will be created in the current directory.
Be careful not to commit unintentionally.

Continue anyway? (yes/no)
```

**Step 2: Create Worktree** (if git repo)

Generate paths:
```bash
BRANCH="test/${MODULE}-${LAYER}-coverage"
WORKTREE_PATH="${REPO}/../$(basename ${REPO})-${MODULE}-${LAYER}"
```

Check for collision:
```bash
if [ -e "${WORKTREE_PATH}" ]; then
  echo "❌ Path already exists: ${WORKTREE_PATH}"
  echo "Options:"
  echo "1. Remove it: rm -rf ${WORKTREE_PATH}"
  echo "2. Resume existing worktree"
  # Ask user what to do
fi
```

Create worktree:
```bash
git worktree add "${WORKTREE_PATH}" -b "${BRANCH}"
```

Verify creation:
```bash
git worktree list
ls -la "${WORKTREE_PATH}"
```

Report:
```
🌳 Worktree Created

Branch: ${BRANCH}
Location: ${WORKTREE_PATH}
Status: Ready for testing agent
```

**Step 3: Spawn Testing Agent**

Use Task tool to spawn testing specialist agent:

Read the agent template:
```
Read agents/testing-specialist.md
```

Inject runtime variables:
- `WORKTREE_PATH` or current directory
- `MODULE`
- `LAYER`
- `COVERAGE_TARGET`
- Strategy content from Phase 1
- File list from Phase 1

Spawn agent:
```
Task({
  subagent_type: 'general-purpose',
  model: 'sonnet',
  description: 'Test ${MODULE}/${LAYER} coverage',
  prompt: `
    [Agent template content with variables injected]
  `
})
```

**Step 4: Monitor Progress**

Report to user:
```
🤖 Testing Agent Working...

Location: ${WORKTREE_PATH}
Target: ${COVERAGE_TARGET}% coverage
Expected duration: 5-60 minutes depending on layer size

You can continue working in the main repository.
The agent is working in isolation.

Check progress: cd ${WORKTREE_PATH} && git log --oneline
```

**Step 5: Wait for Agent Return**

Agent will return a structured summary when complete.

**Mark Phase 2 complete** in TodoWrite.

---

### Phase 3: Review

**Mark Phase 3 as in_progress** in TodoWrite.

**Step 1: Extract Agent Report**

From agent's return message, extract:
- Coverage achieved (statements, branches, functions, lines)
- Number of tests created
- Test file paths
- Production code changes count
- Unreachable code discovered
- Commit hash

**Step 2: Verify Quality Gates**

Run 5 quality gates in the worktree:

```bash
cd ${WORKTREE_PATH}

# Gate 1: Coverage target met
pnpm test src/modules/${MODULE}/${LAYER} --coverage
# Check: statements >= ${COVERAGE_TARGET}%

# Gate 2: All tests passing
pnpm test src/modules/${MODULE}/${LAYER}
# Check: exit code 0, no failures

# Gate 3: Zero production code changes
git diff origin/dev --name-only | grep -v test | grep -v mock | grep -v __tests__
# Check: empty output

# Gate 4: Type-check passing
pnpm type-check
# Check: exit code 0

# Gate 5: Lint passing
pnpm lint
# Check: exit code 0
```

For detailed quality gate definitions, see [quality-gates.md](references/quality-gates.md).

**Step 3: Analyze Results**

Classify outcome:
- ✅ **Success**: All gates passed, coverage >= target
- ⚠️ **Partial Success**: Some gates passed, coverage < target but close
- ❌ **Failure**: Critical gates failed, coverage far from target

**Step 4: Present Summary**

**On Success:**
```
✅ Testing Complete: ${MODULE}/${LAYER}

📊 Coverage Achieved:
  Statements: ${STATEMENTS}% (target: ${TARGET}%)
  Branches: ${BRANCHES}%
  Functions: ${FUNCTIONS}%
  Lines: ${LINES}%

📝 Tests Created:
  - File1.test.ts (${COUNT} tests, ${LOC} lines)
  - File2.test.ts (${COUNT} tests, ${LOC} lines)
  ...

Total: ${TOTAL_TESTS} tests, ${TOTAL_LOC} lines of test code

🔒 Safety Check:
  ✓ Production code changes: 0
  ✓ All tests passing: ${TOTAL_TESTS}/${TOTAL_TESTS}
  ✓ Type-check: PASS
  ✓ Lint: PASS

💾 Commit:
  Branch: ${BRANCH}
  Hash: ${COMMIT_HASH}
  Message: "test(${MODULE}): add ${LAYER} layer tests"

📍 Location: ${WORKTREE_PATH}
```

**On Partial Success:**
```
⚠️ Testing Partially Complete: ${MODULE}/${LAYER}

Coverage: ${ACTUAL}% (target: ${TARGET}%)

Gap Analysis:
[Explain why target not reached]
- File1.ts: Complex integration logic (needs integration test setup)
- File2.ts: Unreachable defensive code (consider removing)

Recommendation: [Accept current coverage OR refactor code OR adjust target]
```

**On Failure:**
```
❌ Testing Blocked: ${MODULE}/${LAYER}

Issue: [Specific failure]

Gate Results:
  [x] Coverage: 45% (target: 90%) - FAIL
  [✓] Tests passing: PASS
  [x] Type-check: 3 errors - FAIL
  [✓] Production code: 0 changes - PASS
  [✓] Lint: PASS

Next Steps:
1. Review errors in ${WORKTREE_PATH}
2. Fix blocking issues
3. Re-run or adjust target
```

**Mark Phase 3 complete** in TodoWrite.

---

### Phase 4: Next Steps

**Mark Phase 4 as in_progress** in TodoWrite.

**Step 1: Calculate Module Progress**

Scan the module for all layers and their coverage:

```bash
# Find all layers
find src/modules/${MODULE} -mindepth 1 -maxdepth 1 -type d
```

For each layer, check if tests exist and get coverage.

Calculate overall module completion:
```
Module: ${MODULE}
  ✅ core: 100% (target: 90%)
  ✅ application: 95% (target: 80%)
  ⏳ infrastructure: 0% (target: 70%) ← Next
  ⏳ boundary: 0% (target: 20%)

Overall: 65% complete
```

**Step 2: Recommend Next Action**

If module incomplete:
```
🎯 Next Recommended Layer

Module: ${MODULE}
Layer: ${NEXT_LAYER}
Reason: [Why this layer next - dependencies, criticality, etc.]
Estimated effort: [Time estimate based on LOC]

Command: /test-layer ${MODULE} ${NEXT_LAYER}

Or ask: "Test the ${NEXT_LAYER} layer of ${MODULE}"
```

If module complete:
```
🎉 Module Complete!

${MODULE} is now fully tested:
  ✅ core: ${COVERAGE}%
  ✅ application: ${COVERAGE}%
  ✅ infrastructure: ${COVERAGE}%
  ✅ boundary: ${COVERAGE}%

Overall module coverage: ${OVERALL}%

Next module to test: ${NEXT_MODULE}
```

**Step 3: Provide Merge Instructions**

```
📦 Ready to Merge

Review the worktree:
  cd ${WORKTREE_PATH}
  git log --oneline
  git diff ${BASE_BRANCH}

To merge to ${BASE_BRANCH}:
  cd ${REPO}
  git merge ${BRANCH}
  git worktree remove ${WORKTREE_PATH}
  git branch -d ${BRANCH}

Or create PR:
  git push origin ${BRANCH}
  gh pr create --title "test(${MODULE}): ${LAYER} layer coverage"
```

**Mark Phase 4 complete** in TodoWrite. Mark ALL todos complete.

---

## Quality Gates

The skill enforces 5 quality gates before accepting test results:

1. **Coverage Target Met**: Achieved coverage >= target
2. **All Tests Passing**: 100% pass rate, zero failures
3. **Zero Production Changes**: Only test files modified
4. **Type-Check Passing**: No type errors introduced
5. **Lint Passing**: Code style compliance

See [quality-gates.md](references/quality-gates.md) for detailed verification steps.

---

## Troubleshooting

### No Strategy File
**Symptom**: `.claude/testing-strategy.md` not found

**Solution**: Run `/setup-testing-strategy` to create one interactively

### Layer Not Found
**Symptom**: Target layer directory doesn't exist

**Check**:
- Module name spelling
- Layer name spelling (case-sensitive)
- Path patterns in strategy file

### Coverage Target Unreachable
**Symptom**: Agent reports target can't be met

**Options**:
1. Lower target: `/test-layer ${MODULE} ${LAYER} --coverage 70`
2. Refactor untestable code
3. Document why coverage is limited

### Worktree Path Collision
**Symptom**: Worktree path already exists

**Options**:
1. Remove existing: `rm -rf ${WORKTREE_PATH}`
2. Clean up worktrees: `git worktree prune`
3. Resume existing worktree (manual)

### Agent Modified Production Code
**Symptom**: Quality gate 3 fails

**Action**:
- REJECT the commit
- Review changes: `git diff origin/dev`
- Re-spawn agent with stricter instructions
- Emphasize: "Tests ONLY. Zero production code changes."

---

## References

For detailed information:
- [Workflow Phases](references/workflow-phases.md) - Step-by-step phase execution
- [Quality Gates](references/quality-gates.md) - Gate definitions and verification
- [Result Type Patterns](references/result-type-patterns.md) - TypeScript Result<T,E> usage

---

## Examples

### Basic Usage (Model-Invoked)

User: "Test the core layer of the photoshoot module"

Skill activates automatically, reads strategy, executes workflow.

### Explicit Invocation (Command)

```
/test-layer photoshoot core
```

### Custom Coverage Target

```
/test-layer auth application --coverage 85
```

User: "Test auth application layer with 85% coverage"

### Multiple Layers

After testing core:
User: "Now test the application layer"

Skill continues with application layer for same module.

---

## Notes

- **Strategy file is required**: Without it, skill cannot determine what/how to test
- **Architecture-agnostic**: Works with any architecture defined in strategy
- **Worktree isolation**: Safely test in parallel without affecting main work
- **Quality-first**: Enforces gates to ensure test quality, not just coverage numbers
- **Stateless agents**: Testing agent is autonomous and returns complete summary
