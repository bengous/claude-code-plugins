# Workflow Phases Reference

Detailed phase-by-phase execution guide for the layer-testing skill.

---

## Phase 1: Strategy & Analysis

### Objective
Understand what to test, how to test it, and get user approval before creating worktree.

### Steps

**1.1 Create Task List**
```
TaskCreate(subject: "Phase 1: Strategy & Analysis", description: "...", activeForm: "Analyzing")
TaskCreate(subject: "Phase 2: Execute", description: "...", activeForm: "Executing")
TaskCreate(subject: "Phase 3: Review", description: "...", activeForm: "Reviewing")
TaskCreate(subject: "Phase 4: Next Steps", description: "...", activeForm: "Completing")

TaskGet(taskId: "phase-1-id")
TaskUpdate(taskId: "phase-1-id", status: "in_progress")
```

**1.2 Read Testing Strategy**

Location: `.claude/testing-strategy.md` in project root

What to extract:
- Layer definitions (path patterns, coverage targets)
- "What to test" patterns for this layer type
- "What to skip" patterns for this layer type
- Testing framework/tools
- Architecture-specific rules (e.g., Result<T,E> type guards)

**1.3 Parse Arguments**

Expected format:
```
MODULE LAYER [--coverage PERCENT]
```

Examples:
- `photoshoot core` → module="photoshoot", layer="core", coverage=default
- `auth application --coverage 85` → module="auth", layer="application", coverage=85

Validation:
- MODULE: Required, non-empty
- LAYER: Required, must exist in strategy file
- --coverage: Optional, 0-100 range

**1.4 Verify Structure Exists**

Search patterns (try in order):
1. `src/modules/${MODULE}/${LAYER}/`
2. `src/${MODULE}/${LAYER}/`
3. Custom pattern from strategy file

If not found, list available modules and layers to help user.

**1.5 Analyze Files**

Scan directory:
```bash
find ${LAYER_PATH} -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \) ! -path "*/node_modules/*"
```

For each file, determine category:
- **Testable**: Matches "what to test" from strategy (entities, use cases, repositories, etc.)
- **Skip**: Matches "what to skip" from strategy (events, types, re-exports, existing tests/mocks)

Count lines:
```bash
wc -l ${file}
```

Check for existing tests:
```bash
find ${LAYER_PATH} -type f \( -name "*.test.*" -o -name "*.spec.*" -o -path "*/__tests__/*" \)
```

Attempt to get current coverage (may fail if no tests exist):
```bash
pnpm test ${LAYER_PATH} --coverage --reporter=json 2>/dev/null || echo "No coverage data"
```

**1.6 Present Analysis**

Format output clearly:
```
📊 Analysis Complete: ${MODULE}/${LAYER}

Layer Type: [e.g., "Core/Domain - Business logic and entities"]
Coverage Target: ${TARGET}%

Files Summary:
  Total: ${TOTAL} files (${TOTAL_LOC} lines)
  Testable: ${TESTABLE} files (${TESTABLE_LOC} lines)
  Skip: ${SKIP} files (${SKIP_LOC} lines)

Current State:
  Existing tests: ${TEST_COUNT} files
  Current coverage: ${CURRENT}% (or "N/A - no tests yet")
  Gap to target: ${GAP}%

Breakdown:

Testable Files:
  ✅ Entity1.ts (245 LOC) - Entity with business rules
  ✅ UseCase1.ts (180 LOC) - Orchestration logic
  ✅ Repository1.ts (120 LOC) - Database operations

Skipped Files:
  ❌ Events.ts (30 LOC) - Event definitions (no logic)
  ❌ Types.ts (15 LOC) - Type definitions only
  ❌ index.ts (5 LOC) - Re-export file

Estimated effort: [1-4 hours based on TESTABLE_LOC and gap]

Ready to proceed?
```

**1.7 Get User Approval**

Wait for explicit "yes", "proceed", "continue", or similar.

If user declines or asks questions, respond appropriately.

### Troubleshooting

**Issue: Strategy file not found**
```
❌ No .claude/testing-strategy.md found

This skill requires a testing strategy file.

Run: /setup-testing-strategy

Or create manually using template at:
  orchestration/skills/layer-testing/templates/testing-strategy-template.md
```

**Issue: Layer not in strategy**
```
⚠️ Layer "${LAYER}" not defined in testing strategy

Available layers from strategy:
  - core (coverage: 90%)
  - application (coverage: 80%)
  - infrastructure (coverage: 70%)

Add ${LAYER} definition to .claude/testing-strategy.md or use a defined layer.
```

**Issue: Layer directory not found**
```
❌ Layer not found: ${MODULE}/${LAYER}

Searched:
  - src/modules/${MODULE}/${LAYER}/ (not found)
  - src/${MODULE}/${LAYER}/ (not found)

Available modules:
  [list directories]

For module "${MODULE}", available layers:
  [list subdirectories]
```

---

## Phase 2: Execute

### Objective
Create isolated worktree and spawn testing agent to implement tests autonomously.

### Steps

**2.1 Update Task Status**
```
TaskGet(taskId: "phase-2-id")
TaskUpdate(taskId: "phase-2-id", status: "in_progress")
```

**2.2 Determine Repository Root**

```bash
REPO=$(git rev-parse --show-toplevel 2>/dev/null)
```

If not in git repository:
```
⚠️ Not a git repository

Worktree isolation requires git. Options:
1. Initialize git: git init
2. Proceed without isolation (tests in current directory)

Warning: Without isolation, you risk conflicts with current work.

Continue without git? (yes/no)
```

If user agrees, use current directory instead of worktree.

**2.3 Check for Worktree Collision**

```bash
WORKTREE_PATH="${REPO}/../$(basename ${REPO})-${MODULE}-${LAYER}"

if [ -e "${WORKTREE_PATH}" ]; then
  echo "Path already exists"
fi
```

If collision:
```
❌ Worktree path exists: ${WORKTREE_PATH}

Options:
1. Remove it: rm -rf ${WORKTREE_PATH}
2. Resume existing worktree (manual)
3. Choose different name

Automatically remove? (yes/no)
```

**2.4 Create Worktree**

```bash
BRANCH="test/${MODULE}-${LAYER}-coverage"

git worktree add "${WORKTREE_PATH}" -b "${BRANCH}"
```

Verify:
```bash
git worktree list | grep "${WORKTREE_PATH}"
ls -la "${WORKTREE_PATH}" | head -5
```

Report:
```
🌳 Worktree Created

Branch: ${BRANCH}
Location: ${WORKTREE_PATH}
Based on: ${BASE_BRANCH} (current branch)

Status: ✅ Ready for testing agent
```

**2.5 Prepare Agent Context**

Collect information to pass to agent:
- Worktree path: `${WORKTREE_PATH}`
- Module: `${MODULE}`
- Layer: `${LAYER}`
- Coverage target: `${COVERAGE_TARGET}`
- Testing strategy: Content from `.claude/testing-strategy.md`
- File list: From Phase 1 analysis (formatted as JSON or structured text)
- Test framework: From strategy
- Base branch: Current branch name for later diffing

**2.6 Spawn Testing Agent**

Read agent template:
```
Read orchestration/agents/testing-specialist.md
```

Inject variables into template (replace placeholders like `{WORKTREE_PATH}`, `{MODULE}`, etc.).

Use Task tool:
```typescript
Task({
  subagent_type: 'general-purpose',
  model: 'sonnet',
  description: 'Test ${MODULE}/${LAYER} coverage',
  prompt: `
    ${AGENT_TEMPLATE_WITH_VARIABLES_INJECTED}
  `
})
```

**2.7 Report Progress**

```
🤖 Testing Agent Spawned

Working in: ${WORKTREE_PATH}
Target: ${COVERAGE_TARGET}% coverage
Strategy: [brief summary from strategy file]

Expected duration:
  - Small layers (<500 LOC): 5-15 minutes
  - Medium layers (500-2000 LOC): 15-45 minutes
  - Large layers (>2000 LOC): 45-90 minutes

You can continue working in main repository.
Agent is isolated in worktree.

Monitor progress:
  cd ${WORKTREE_PATH}
  git log --oneline

Waiting for agent completion...
```

**2.8 Wait for Agent**

Agent works autonomously. Will return structured summary when complete.

### Troubleshooting

**Issue: Worktree creation fails**
```
Error: fatal: '${WORKTREE_PATH}' already exists
```

**Fix**: Remove existing or choose different path

**Issue: Branch already exists**
```
Error: fatal: A branch named '${BRANCH}' already exists
```

**Fix**:
```bash
# Delete old branch
git branch -D ${BRANCH}

# Or use different branch name
BRANCH="test/${MODULE}-${LAYER}-coverage-$(date +%s)"
```

**Issue: Agent doesn't respond**

Possible causes:
- Agent hit context limit
- Agent encountered blocker
- Network issue (cloud execution)

**Debug**:
```bash
# Check worktree manually
cd ${WORKTREE_PATH}
git log --oneline  # See if any commits
git status  # See working tree state
```

---

## Phase 3: Review

### Objective
Verify agent results against quality gates and present comprehensive summary.

### Steps

**3.1 Update Task Status**
```
TaskGet(taskId: "phase-3-id")
TaskUpdate(taskId: "phase-3-id", status: "in_progress")
```

**3.2 Extract Agent Report**

Agent should return structured information:
- Coverage achieved (%, broken down by statements/branches/functions/lines)
- Tests created (file paths, test counts, LOC)
- Production code changes (should be 0)
- Unreachable code discovered
- Commit hash
- Any issues encountered

Parse this information from agent's final message.

**3.3 Run Quality Gates**

Execute all 5 gates in the worktree:

```bash
cd ${WORKTREE_PATH}

# Gate 1: Coverage
pnpm test ${TARGET_PATH} --coverage
# Extract: Statements X%

# Gate 2: Tests passing
pnpm test ${TARGET_PATH}
# Check: exit code 0

# Gate 3: Production changes
git diff ${BASE_BRANCH} --name-only | grep -v test | grep -v mock | grep -v __tests__
# Check: empty output

# Gate 4: Type-check
pnpm type-check
# Check: exit code 0

# Gate 5: Lint
pnpm lint
# Check: exit code 0
```

See [quality-gates.md](quality-gates.md) for detailed gate definitions.

**3.4 Classify Outcome**

Based on gate results:

**Success**: All gates pass, coverage >= target
**Partial**: Some gates pass, coverage close to target (within 5%)
**Failure**: Critical gates fail or coverage far from target

**3.5 Present Summary**

**On Success:**
```
✅ Testing Complete: ${MODULE}/${LAYER}

📊 Coverage Achieved:
  Statements: ${STMT}% (target: ${TARGET}%)
  Branches: ${BRANCH}%
  Functions: ${FUNC}%
  Lines: ${LINES}%

📝 Tests Created:
  - File1.test.ts (25 tests, 350 LOC)
  - File2.test.ts (15 tests, 200 LOC)
  Total: 40 tests, 550 LOC

🔒 Quality Gates:
  ✅ Coverage target met (${STMT}% >= ${TARGET}%)
  ✅ All tests passing (40/40)
  ✅ Zero production changes (0 files)
  ✅ Type-check passing
  ✅ Lint passing

💾 Commit:
  Branch: ${BRANCH}
  Hash: ${COMMIT_HASH}
  Message: "test(${MODULE}): add ${LAYER} layer tests"

📍 Location: ${WORKTREE_PATH}

Next: Review and merge (see Phase 4)
```

**On Partial Success:**
```
⚠️ Testing Partially Complete: ${MODULE}/${LAYER}

Coverage: ${ACTUAL}% (target: ${TARGET}%)
Gap: ${GAP}% below target

Gap Analysis:
- File1.ts: Unreachable defensive code (lines 45-48)
- File2.ts: Complex integration logic (needs integration test setup)

Quality Gates:
  ⚠️ Coverage: ${ACTUAL}% < ${TARGET}% (gap: ${GAP}%)
  ✅ All tests passing (32/32)
  ✅ Zero production changes
  ✅ Type-check passing
  ✅ Lint passing

Options:
1. Accept current coverage (document gap justification)
2. Adjust target: --coverage ${ACTUAL}
3. Add more tests manually in ${WORKTREE_PATH}
4. Refactor uncovered code to be testable

Recommendation: [Based on gap analysis]
```

**On Failure:**
```
❌ Testing Blocked: ${MODULE}/${LAYER}

Primary Issue: [Specific blocker]

Quality Gates:
  ❌ Coverage: 45% (target: 90%) - FAIL
  ✅ Tests passing: PASS
  ❌ Type-check: 3 errors - FAIL
  ✅ Production changes: 0 - PASS
  ✅ Lint: PASS

Errors:
  [List type errors or test failures]

Next Steps:
1. Investigate in ${WORKTREE_PATH}
2. Fix blocking issues
3. Re-run agent or adjust expectations
```

**3.6 Update Task Status**
```
TaskGet(taskId: "phase-3-id")
TaskUpdate(taskId: "phase-3-id", status: "completed")
```

### Troubleshooting

**Issue: Can't run commands in worktree**
```
Error: pnpm: command not found
```

**Cause**: Dependencies not installed in worktree

**Fix**:
```bash
cd ${WORKTREE_PATH}
pnpm install
```

**Issue: Tests fail in worktree but pass locally**

**Cause**: Different node_modules or config

**Debug**:
```bash
cd ${WORKTREE_PATH}
diff package.json ${REPO}/package.json
diff vitest.config.ts ${REPO}/vitest.config.ts
```

---

## Phase 4: Next Steps

### Objective
Guide user on merge, next testing targets, and future actions.

### Steps

**4.1 Update Task Status**
```
TaskGet(taskId: "phase-4-id")
TaskUpdate(taskId: "phase-4-id", status: "in_progress")
```

**4.2 Calculate Module Progress**

Find all layers in the module:
```bash
find src/modules/${MODULE} -mindepth 1 -maxdepth 1 -type d
```

For each layer, check if tests exist and coverage:
```bash
pnpm test src/modules/${MODULE}/${LAYER} --coverage --silent 2>/dev/null
```

Calculate:
- Layers completed (coverage >= target)
- Layers in progress (some tests, coverage < target)
- Layers untested (no tests)

**4.3 Recommend Next Layer**

Priority order:
1. Layers with dependencies on completed layers
2. Core/domain first (foundational)
3. Application next (depends on core)
4. Infrastructure next (depends on application)
5. Boundary last (depends on all)

Example:
```
Module Progress: ${MODULE}

Layers:
  ✅ core: 100% (target: 90%) - Complete
  ✅ application: 95% (target: 80%) - Complete
  ⏳ infrastructure: 0% (target: 70%) - Next recommended
  ⏳ boundary: 0% (target: 20%) - Later

Overall: 50% complete (2/4 layers)

🎯 Next Recommended Layer: infrastructure

Reason: Application layer complete, infrastructure adapters ready to test
Estimated effort: 2-3 hours (8 files, ~800 LOC)

Command: /test-layer ${MODULE} infrastructure

Or ask: "Test the infrastructure layer of ${MODULE}"
```

**4.4 Provide Merge Instructions**

```
📦 Ready to Merge

Review worktree:
  cd ${WORKTREE_PATH}
  git log --oneline
  git diff ${BASE_BRANCH}

Option 1: Direct merge (if you own this branch)
  cd ${REPO}
  git merge ${BRANCH}
  git worktree remove ${WORKTREE_PATH}
  git branch -d ${BRANCH}

Option 2: Create PR (team workflow)
  cd ${WORKTREE_PATH}
  git push origin ${BRANCH}
  gh pr create --title "test(${MODULE}): ${LAYER} layer coverage" --base dev

Option 3: Manual review first
  1. Review all tests in ${WORKTREE_PATH}
  2. Run tests yourself: cd ${WORKTREE_PATH} && pnpm test
  3. Then choose option 1 or 2
```

**4.5 Suggest Follow-up Actions**

Based on results:
- If unreachable code found: Suggest removing dead code
- If coverage gaps documented: Suggest refactoring
- If module complete: Suggest next module
- If patterns observed: Suggest updating strategy file

**4.6 Update Task Status**
```
# Mark Phase 4 complete
TaskGet(taskId: "phase-4-id")
TaskUpdate(taskId: "phase-4-id", status: "completed")
```

### Troubleshooting

**Issue: Can't merge due to conflicts**

**Cause**: Main branch changed during testing

**Fix**:
```bash
cd ${WORKTREE_PATH}
git fetch origin
git rebase origin/${BASE_BRANCH}
# Resolve conflicts
git rebase --continue
```

**Issue: Want to undo/discard tests**

**Fix**:
```bash
cd ${REPO}
git worktree remove ${WORKTREE_PATH} --force
git branch -D ${BRANCH}
```

Tests are isolated in worktree, so no impact on main work.

---

## Summary

The 4-phase workflow:
1. **Strategy & Analysis**: Understand what to test, get approval
2. **Execute**: Create worktree, spawn agent, wait for completion
3. **Review**: Verify quality gates, present summary
4. **Next Steps**: Guide merge and recommend next actions

Each phase builds on the previous:
- Phase 1 provides context for Phase 2
- Phase 2 creates tests for Phase 3 to verify
- Phase 3 results inform Phase 4 recommendations

Phases are sequential and must not be skipped.
