# Quality Gates Reference

This document defines the 5 quality gates that must pass before accepting test results.

---

## Gate 1: Coverage Target Met

**What it checks**: Achieved coverage meets or exceeds the target percentage.

**How to verify**:
```bash
cd ${WORKTREE_PATH}
pnpm test src/modules/${MODULE}/${LAYER} --coverage
```

**Success criteria**:
- Statements coverage >= ${COVERAGE_TARGET}%
- (Primary metric - others are informational)

**Common failures**:
- Unreachable code (defensive checks, dead code paths)
- Complex integration logic (needs integration test setup, not unit tests)
- Framework boilerplate (should be excluded from coverage)

**What to do if failing**:
1. Review uncovered lines - are they testable?
2. If unreachable: Remove dead code
3. If integration logic: Create integration test or accept lower coverage
4. If framework code: Exclude from coverage config
5. If legitimate gap: Lower target with justification

---

## Gate 2: All Tests Passing

**What it checks**: 100% test pass rate, zero failures, zero errors.

**How to verify**:
```bash
cd ${WORKTREE_PATH}
pnpm test src/modules/${MODULE}/${LAYER}
```

**Success criteria**:
- Exit code: 0
- Output shows: "Tests: X passed, X total" (no failures, no skipped)
- No error stack traces

**Common failures**:
- Incorrect mocking (mock doesn't match real behavior)
- Async timing issues (missing await, race conditions)
- Test isolation issues (tests affect each other)
- Incorrect assertions (testing wrong thing)

**What to do if failing**:
1. Review test output carefully
2. Run single failing test: `pnpm test path/to/test.ts -t "test name"`
3. Check mock implementations
4. Verify async/await usage
5. Ensure beforeEach/afterEach clean up state

---

## Gate 3: Zero Production Code Changes

**What it checks**: Only test files, mock files, and test utilities were modified. Production code untouched.

**How to verify**:
```bash
cd ${WORKTREE_PATH}
git diff origin/dev --name-only | grep -v test | grep -v mock | grep -v __tests__
```

**Success criteria**:
- Output is empty (no files listed)
- OR: Only files matching test patterns (.test., .spec., __tests__/, /mocks/)

**Common failures**:
- Agent "fixed" bugs found during testing (not allowed!)
- Agent added exports for testing (use test utilities instead)
- Agent modified types to make testing easier (not allowed!)
- Accidental edits

**What to do if failing**:
1. Review the diff: `git diff origin/dev`
2. Identify which production files changed
3. Determine if changes are:
   - **Bug fixes**: Note for separate PR, revert from tests
   - **Test enablement**: Use test utilities, revert production changes
   - **Accidental**: Revert
4. REJECT commit if production code changed
5. Re-spawn agent with stricter instructions

**Critical**: This is a hard gate. Production code modifications invalidate the test-only workflow.

---

## Gate 4: Type-Check Passing

**What it checks**: TypeScript compilation succeeds, no type errors introduced.

**How to verify**:
```bash
cd ${WORKTREE_PATH}
pnpm type-check
```

**Success criteria**:
- Exit code: 0
- No "error TS" messages in output

**Common failures**:
- Using `result.ok` instead of `Result.isOk(result)` (type guard required)
- Accessing `.value` or `.error` without type guard
- Incorrect mock types
- Missing type imports

**What to do if failing**:
1. Review type errors carefully
2. Most common: Result<T,E> pattern violations (see [result-type-patterns.md](result-type-patterns.md))
3. Fix by using proper type guards:
   ```typescript
   if (Result.isOk(result)) {
     // Safe to access result.value here
   }
   ```
4. Ensure mocks match interface signatures exactly

---

## Gate 5: Lint Passing

**What it checks**: Code style compliance with project linting rules.

**How to verify**:
```bash
cd ${WORKTREE_PATH}
pnpm lint
```

**Success criteria**:
- Exit code: 0
- No warnings or errors

**Common failures**:
- Unused imports
- Inconsistent formatting (should be rare if using auto-formatter)
- Complexity warnings (tests too complex)
- Console.log left in tests

**What to do if failing**:
1. Run auto-fix if available: `pnpm lint --fix`
2. Review remaining issues
3. Fix manually if auto-fix insufficient
4. Consider if lint rule should be adjusted for tests (discuss with team)

---

## Gate Execution Order

Run gates in this order for fastest feedback:

1. **Lint** (fastest, ~5s) - Catches style issues quickly
2. **Type-check** (fast, ~10-30s) - Catches type errors before running tests
3. **Tests passing** (medium, ~30s-5m) - Validates test logic
4. **Coverage** (medium, ~30s-5m) - Often same command as tests
5. **Production changes** (instant) - Final safety check

If any gate fails, STOP and fix before proceeding to next gate.

---

## Partial Success Handling

If coverage is close but not quite at target (e.g., 88% vs 90% target):

**Analyze the gap**:
```bash
pnpm test src/modules/${MODULE}/${LAYER} --coverage --reporter=verbose
```

Look for:
- **Unreachable code**: Document and remove from production
- **Edge cases**: Add tests for critical paths
- **Framework code**: Exclude from coverage
- **Integration logic**: Needs different test approach

**Decision matrix**:
- Gap < 5% AND no critical paths uncovered → **Accept**
- Gap < 5% AND critical paths missing → **Add tests**
- Gap >= 5% → **Investigate and fix**

**Document acceptance**:
If accepting lower coverage:
```
⚠️ Coverage: 88% (target: 90%)

Gap Analysis:
- File.ts:45-48 (2%): Unreachable defensive check (filed issue #123 to remove)

Accepted: Critical paths covered, gap is non-functional code.
```

---

## Enforcement Philosophy

**Why strict gates?**
1. **Coverage isn't quality**: High coverage with poor tests is worse than low coverage with good tests
2. **Production safety**: Test changes must be isolated to prevent accidental bugs
3. **Type safety**: Result<T,E> pattern compliance prevents runtime errors
4. **Maintainability**: Lint ensures consistent, readable test code
5. **Team confidence**: Passing gates means tests are trustworthy

**When to be flexible**:
- Coverage target: Can be lowered with justification
- Lint rules: Can be disabled for specific test patterns (team decision)

**When to be strict**:
- Production code changes: NEVER accept in testing workflow
- Type-check: ALWAYS must pass (type safety is critical)
- Tests passing: ALWAYS must pass (failing tests are useless)

---

## Examples

### All Gates Passing

```bash
$ pnpm lint
✓ No linting errors

$ pnpm type-check
✓ No type errors

$ pnpm test src/modules/auth/core --coverage
Tests: 25 passed, 25 total
Coverage: Statements 92%, Branches 88%, Functions 95%, Lines 91%
✓ Coverage target met (90%)

$ git diff origin/dev --name-only | grep -v test
(empty output)
✓ Zero production changes

✅ All quality gates PASSED
```

### Gate 3 Failure (Production Changes)

```bash
$ git diff origin/dev --name-only | grep -v test
src/modules/auth/core/User.ts
src/modules/auth/core/UserValidator.ts

❌ Gate 3 FAILED: Production code modified

Review changes:
$ git diff origin/dev src/modules/auth/core/User.ts

Found:
- Added export for private method (test enablement)
- Fixed validation bug (separate concern)

Action:
1. Revert production changes
2. File bug fix as separate issue
3. Re-run tests without production modifications
```

### Gate 1 Partial Success

```bash
$ pnpm test src/modules/auth/application --coverage
Coverage: Statements 88%, Branches 85%, Functions 90%, Lines 87%

⚠️ Gate 1: Coverage below target (88% vs 90%)

Gap analysis:
- CreateUserUseCase.ts: 75% (missing error path tests)
- UpdateUserUseCase.ts: 95% (good)
- DeleteUserUseCase.ts: 92% (good)

Recommendation: Add error path tests to CreateUserUseCase.ts
Estimated: 2 more tests needed
```

---

## Troubleshooting

### Coverage command fails
**Symptom**: `pnpm test --coverage` returns error

**Check**:
- Is coverage package installed? (`vitest` includes coverage)
- Is coverage config present? (vitest.config.ts)
- Try: `pnpm test --coverage --run` (disable watch mode)

### Type-check finds errors in unrelated files
**Symptom**: Type errors in files not being tested

**This is expected**: TypeScript checks entire project for consistency

**Options**:
1. Fix the errors (they're real issues)
2. Skip for now (note in summary, fix in separate PR)

### Lint fails on auto-generated files
**Symptom**: Mock files or test fixtures fail lint

**Solution**: Add exclusions to .eslintignore:
```
**/__tests__/fixtures/
**/__mocks__/generated/
```
