---
name: layer-testing
description: |
  Generate comprehensive tests for architectural layers with interactive guidance and isolated worktrees.
  Use when the user wants to test a specific layer (core, domain, application, infrastructure, boundary)
  in a modular codebase. Reads testing strategy from .claude/testing-strategy.md or custom playbook file.
  Supports interactive file selection via conversation. Handles worktree creation, agent delegation,
  and quality verification with 100% coverage as ideal target.
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - Task(*:*)
  - TodoWrite(*:*)
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

### Required: Testing Strategy or Playbook File

This skill requires guidance from either:
- **`.claude/testing-strategy.md`** (default) - Project-wide testing strategy
- **Custom playbook file** - Passed via `@file` syntax (e.g., `/test-layer auth core @playbook.md`)

The guidance file should define:
- Layer types and coverage targets (100% ideal)
- What to test vs skip for each layer
- Testing patterns and frameworks
- Architecture-specific rules
- Agent constraints and quality gates

**If missing**, suggest running: `/setup-testing-strategy`

**Playbook syntax**: Users can reference custom playbooks:
- `/test-layer <module> <layer> @docs/my-playbook.md`
- `/test-layer <module> <layer> @testing-guide.md`

**Why required**: Different projects have different architectures and philosophies. The guidance file provides principles while you collaborate with the user on specifics.

### Optional: Git Repository

Project should be a git repository for worktree management. If not, the skill can still analyze and provide testing guidance without worktree isolation.

---

## Workflow Overview

The skill follows a 4-phase **interactive** workflow:

### Phase 1: Strategy & Analysis (INTERACTIVE)
- Read testing guidance (`.claude/testing-strategy.md` or `@file`)
- Parse arguments (module, layer, `@playbook`, coverage override)
- Scan target layer directory
- Categorize files (testable vs skip based on strategy)
- **Present analysis and ASK user which files to test**
- **Let user choose**: all recommended, file-by-file, or custom selection
- Calculate metrics (LOC, current coverage, gap)
- Get final approval on testing plan

### Phase 2: Execute (GUIDED)
- Create isolated worktree (branch: `test/{module}-{layer}-coverage`)
- Spawn testing specialist agent with:
  - Testing strategy/playbook from Phase 1
  - **User-selected file list** (not automatic)
  - Worktree path and branch
  - Coverage target (100% ideal)
  - **Permission to ask questions** via AskUserQuestion
- Agent works in isolation **but can ask for guidance**
- Wait for agent completion

### Phase 3: Review (COLLABORATIVE)
- Verify agent results against quality gates
- Check coverage achieved vs target (100% ideal, gaps documented)
- **Review unreachable code findings** (noted, not blocking)
- Verify zero production code changes
- Validate all tests passing
- Present comprehensive summary with gap explanations

### Phase 4: Next Steps (ADVISORY)
- Calculate overall module progress
- Recommend next layer to test (if applicable)
- Provide merge instructions
- **Suggest reviewing unreachable code** for removal
- Advise on coverage gaps and next priorities

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

**Step 2: Read Testing Guidance**

Check for playbook file reference or use default strategy:

```bash
# Check if @file syntax used in arguments
if [[ "$ARGS" =~ @([^ ]+) ]]; then
  PLAYBOOK_FILE="${BASH_REMATCH[1]}"

  # Read custom playbook
  if [[ -f "$PLAYBOOK_FILE" ]]; then
    cat "$PLAYBOOK_FILE"
  else
    echo "❌ Playbook file not found: $PLAYBOOK_FILE"
    exit 1
  fi
else
  # Use default strategy file
  if [[ -f .claude/testing-strategy.md ]]; then
    cat .claude/testing-strategy.md
  else
    echo "❌ No testing strategy found"
    echo "Run: /setup-testing-strategy"
    echo "Or provide playbook: /test-layer <module> <layer> @playbook.md"
    exit 1
  fi
fi
```

Extract from guidance:
- Layer definitions and coverage targets
- What to test vs skip patterns
- Testing principles and constraints
- Quality gates and expectations

**Step 3: Get Testing Parameters**

When invoked via `/test-layer` command, the arguments will be provided in conversation context:
```
Testing Request:
- Module: auth
- Layer: infrastructure
- Playbook: docs/testing/playbook.md
- Coverage Target: 100%
- Interactive Mode: no
```

If invoked naturally (e.g., "test the auth infrastructure layer"), ask the user for:
- Module name (required)
- Layer name (required)
- Playbook file (optional, default: `.claude/testing-strategy.md`)
- Coverage target (optional, default: 100%)

Store these parameters for use in subsequent steps.

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

**Step 5: Run Coverage First (Pragmatic Fast Path)**

Check for existing tests:
```bash
TEST_FILES=$(find src/modules/${MODULE}/${LAYER} -name "*.test.*" -o -path "*/__tests__/*" | wc -l)
```

**If NO tests exist** (`$TEST_FILES -eq 0`):
- Skip coverage analysis
- Jump to Step 6 (File Exploration)

**If tests exist** (`$TEST_FILES -gt 0`):

Detect test framework and run coverage:
```bash
# Detect framework
if [[ -f "vitest.config.ts" ]] || grep -q "vitest" package.json 2>/dev/null; then
  echo "⏳ Running coverage analysis with Vitest (may take 30-60s)..."
  pnpm test src/modules/${MODULE}/${LAYER} --coverage --reporter=json --reporter=json-summary 2>&1 | tee /tmp/coverage-output.log
  COVERAGE_JSON="coverage/coverage-summary.json"
elif [[ -f "jest.config.js" ]] || grep -q "jest" package.json 2>/dev/null; then
  echo "⏳ Running coverage analysis with Jest..."
  pnpm test -- src/modules/${MODULE}/${LAYER} --coverage --coverageReporters=json-summary 2>&1
  COVERAGE_JSON="coverage/coverage-summary.json"
else
  echo "⚠️  Test framework not detected, skipping coverage"
  # Fallback to file exploration
fi
```

**Parse coverage results:**
```bash
if [[ -f "$COVERAGE_JSON" ]]; then
  # Extract total coverage %
  TOTAL_COVERAGE=$(jq '.total.lines.pct' "$COVERAGE_JSON")

  # Get per-file coverage
  jq -r '.[] | "\(.lines.pct)% \(path)"' "$COVERAGE_JSON" > /tmp/file-coverage.txt
fi
```

**Branch based on coverage:**

**If 100% coverage:**
```
✅ ALREADY COMPLETE: ${MODULE}/${LAYER}

Coverage: 100% (all lines covered)
Tests: ${TEST_FILES} test files

This layer is fully tested! 🎉

Options:
1. Exit (nothing to do)
2. Verify tests are comprehensive (audit test quality)
3. Enhance tests (edge cases, error scenarios)

What would you like to do?
```

STOP and wait for user response. If user chooses "Exit", terminate successfully.

**If 0% coverage or partial (<100%):**
- Store coverage data for later use
- Continue to Step 6 (File Exploration)
- Use coverage to inform recommendations

**If coverage fails:**
```
⚠️  Coverage analysis failed (see output above)
Possible causes: missing dependencies, failing tests, incorrect configuration

Falling back to file-based analysis...
```
- Continue to Step 6 (File Exploration)
- Proceed without coverage data

---

**Step 6: Analyze Files (Informed by Coverage)**

Scan the layer directory and categorize files:

```bash
find src/modules/${MODULE}/${LAYER} -name "*.ts" ! -name "*.test.*" ! -path "*/__tests__/*"
```

For each file:
- Determine testability (matches playbook "what to test" patterns)
- Check coverage % (if coverage data available from Step 5)
- Calculate LOC
- Categorize: Business Logic / Utilities / Framework (Skip)

**If coverage data available:**
- Cross-reference files with coverage report
- Identify: 100% covered, partially covered, not covered
- Show uncovered line ranges for partial files

**Step 7: Present Analysis with Actual Coverage**

Show comprehensive analysis with REAL coverage data:

```
📊 Coverage Analysis: ${MODULE}/${LAYER}

Playbook: [file used for guidance]
Layer Type: [from playbook/strategy]
Current Coverage: 78.5% (ACTUAL from tests, not estimated)
Target: 100%
Gap: 21.5%

✅ FULLY COVERED (100%):
  - User.ts (250 LOC) - Entity with create() + validation
  - UserValidator.ts (80 LOC) - All 5 business rules tested

⚠️  PARTIALLY COVERED:
  - UserPolicy.ts (60 LOC, 45% covered)
    Uncovered: Lines 12-18, 25-30, 45-50
  - UserHelpers.ts (40 LOC, 60% covered)
    Uncovered: Lines 8-12, 20-25

❌ NOT TESTED (0%):
  - AuthService.ts (120 LOC) - Critical business logic
  - ValidationRules.ts (90 LOC) - 8 validation functions

⊘ SKIP (per playbook):
  - UserStatus.ts (15 LOC) - Enum (no logic)
  - events.ts (25 LOC) - Event definitions
  - types.ts (10 LOC) - Type aliases

Recommendation: Focus on 2 untested files + complete 2 partial files
Estimated Effort: ~40 tests, 2-3 hours
```

**Step 8: Interactive File Selection**

Ask the user which files to test:

```
Which files should I test?

Options:
1. All gaps (untested + partial) - Achieve 100% coverage
2. Untested only - Focus on 0% files first
3. Partial only - Complete existing tests
4. Custom selection - Specify exact files/lines

Respond with your choice or file numbers.
```

**WAIT for user response before proceeding.**

**Step 8: Drill Down (If needed)**

If user requested custom selection or file-by-file review, ask in conversation:

```
For User.ts (Entity with create() + 3 business methods):
- Test with 100% coverage?
- Test specific methods only?
- Skip this file?
```

Repeat for each file until user is satisfied with the selection.

**Step 9: Finalize Testing Plan**

Present final plan based on user selections:

```
📋 Final Testing Plan

Files Selected for Testing:
  ✅ User.ts (100% coverage)
     - create() method (all validation rules)
     - updateEmail() method
     - updatePassword() method
     - isActive getter

  ✅ UserValidator.ts (specific rules)
     - Email validation rule
     - (Skip: other 4 rules for now)

  ❌ UserPolicy.ts (skipped per your choice)

Coverage target: 100% on selected scope
Estimated: ~25 tests, 1-2 hours

Proceed with this plan? [yes/no]
```

**Step 10: Final Approval**

Wait for user confirmation before creating worktree.

If user declines, mark Phase 1 complete and exit gracefully.

If user approves, proceed to Phase 2 with the **user-selected file list**.

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

Use Task tool to spawn general-purpose agent with minimal prompt:

```typescript
Task({
  subagent_type: 'general-purpose',
  description: 'Test ${MODULE}/${LAYER} coverage',
  prompt: `
You are testing the ${LAYER} layer of the ${MODULE} module.

**Working directory:** ${WORKTREE_PATH}
**Branch:** ${BRANCH}

**Testing guidance:** Read the playbook/strategy at: ${PLAYBOOK_PATH}

**Files selected for testing:**
${FILE_LIST}

**Your mission:**
1. Read the playbook to understand testing principles and constraints
2. Explore the codebase to understand existing patterns
3. Write comprehensive tests for the selected files
4. Follow the playbook's coverage target (100% ideal, gaps documented)
5. Never modify production code (tests only)
6. Handle unreachable code per playbook (note and continue, report at end)
7. Create a single commit when complete

**You can ask questions** if you encounter:
- Unreachable code (should you note and continue?)
- Unclear business rules
- Priority conflicts

**Report when complete:**
- Coverage achieved (%, broken down)
- Tests created (files, count)
- Production code changes (should be 0)
- Unreachable code found (documented)
- Commit hash

The playbook is your guide. Explore the codebase. Ask if uncertain.
  `
})
```

**Key points:**
- **Minimal prompt** - No prescriptive examples or frameworks
- **Points to playbook** - Agent reads strategy for specifics
- **Trusts agent** - Has access to CLAUDE.md, can explore codebase
- **Universal** - Works with any language, framework, architecture

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

**Step 3: Analyze Results & Unreachable Code**

Classify outcome:
- ✅ **Success**: All gates passed, coverage = 100% (or gaps documented)
- ⚠️ **Partial Success**: Coverage < 100% with documented reasons (unreachable code, integration complexity)
- ❌ **Failure**: Critical gates failed (tests failing, production code changed, type errors)

**Unreachable Code Handling:**

If agent reports unreachable code:
```
⚠️  Unreachable Code Found:

File: User.ts
Lines: 87-89
Code: Defensive null check on required field

Analysis:
- Field is validated as required in create()
- Null check is unreachable (dead code)
- Suggests overengineering or legacy defensive code

Coverage Impact:
- ✅ Excluded from coverage calculation
- ✅ Noted in gap documentation
- ❌ Did NOT modify production code (per constraint)

Recommendation:
- Review for removal in separate refactoring PR
- Or document as intentional safety check
- Coverage: 100% on reachable code
```

**Decision:** Unreachable code does NOT block the commit. It is:
1. Noted in summary
2. Excluded from coverage calculation
3. Recommended for review/removal
4. Not blocking (agent continues and reports)

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
