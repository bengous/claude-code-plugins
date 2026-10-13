---
name: layer-testing
description: |
  Generate comprehensive tests for architectural layers with coverage-first analysis.
  Use when testing specific layers (core, domain, application, infrastructure, boundary).
  Reads testing strategy from playbook or uses interactive template selection.
allowed-tools:
  - Bash(pnpm test *)
  - Bash(pnpm typecheck *)
  - Bash(pnpm lint *)
  - Bash(jq *)
  - Bash(git worktree add *)
  - Bash(pnpm install *)
  - Read(~/.claude/plugins/cache/*/claude-orchestration/*/skills/layer-testing/templates/**)
---

# Layer Testing Skill

Orchestrate comprehensive layer testing with coverage analysis and isolated worktrees.

<context>
Coverage-first analysis prevents wasted effort—existing tests may already cover the code you're about to test. Running coverage before writing tests reveals exactly where gaps exist, letting you focus effort on uncovered paths rather than duplicating existing coverage.

Isolated worktrees keep testing work separate from your working branch, preventing accidental commits to main development branches and enabling parallel testing of multiple layers.
</context>

<constraints>
- Write tests only—never modify production code during testing
- Stay within the specified layer—do not test adjacent layers
- Use worktree for all changes—keep working branch clean
- Follow the testing strategy—do not add tests for explicitly skipped patterns
</constraints>

<workflow>

1. **Get Parameters**

**From command invocation:**
```
Testing Request:
- Module: auth
- Layer: infrastructure
- Playbook: docs/playbook.md (optional)
- Coverage Target: 85% (optional; otherwise the strategy's target for the layer)
```

**From natural invocation:**
Ask user for module, layer, playbook path (optional), coverage target (optional).

2. **Get Testing Strategy**

**If playbook provided:**
```bash
Read(${PLAYBOOK_PATH})
```

**If no playbook but `.claude/testing-strategy.md` exists** (written by `/setup-testing-strategy`): use it as the playbook.

**Otherwise:** Ask user to choose:

<strategy_options>
1. Hexagonal Architecture - Domain/Application first, skip infra schemas
2. Clean Architecture - Use cases/Entities first, skip frameworks
3. Layered - Services/Logic first, skip DTOs/configs
4. Custom - I'll answer questions about what to test
</strategy_options>

**If user picks 1-3:** Use template from `skills/layer-testing/templates/`. Full coverage of the core layers is the ideal; the template sets each layer's target, and the request's coverage target, when given, overrides it.

**If user picks 4:** Ask:
- Coverage target? (100%/80%/70%)
- What to test? (business logic only / all code)
- What to skip? (types, schemas, mocks, configs)
- Build strategy from answers

Store strategy for agent use.

3. **Run Coverage First**

**Check for existing tests:**
```bash
find src/modules/${MODULE}/${LAYER} -name "*.test.*" -o -path "*/__tests__/*"
```

**If NO tests:** Skip to step 4

**If tests exist:**

Detect framework and run coverage (run these checks in parallel):
```bash
if [[ -f "vitest.config.ts" ]] || grep -q "vitest" package.json; then
  pnpm test src/modules/${MODULE}/${LAYER} --coverage --reporter=json-summary
elif [[ -f "jest.config.js" ]] || grep -q "jest" package.json; then
  pnpm test -- src/modules/${MODULE}/${LAYER} --coverage --coverageReporters=json-summary
fi
```

Parse `coverage/coverage-summary.json`:
```bash
jq '.total.lines.pct' coverage/coverage-summary.json
```

**If 100% coverage:**
```
✅ Already at 100% coverage!

Options:
1. Exit (nothing to do)
2. Verify test quality
3. Enhance tests

Choose (1-3):
```

If user picks 1, exit successfully.

**If < 100%:** Continue to Step 4

4. **Analyze Files**

Find all files:
```bash
find src/modules/${MODULE}/${LAYER} -name "*.ts" ! -name "*.test.*" ! -path "*/__tests__/*"
```

Categorize using strategy:
- Testable (matches "what to test" patterns)
- Skip (matches "what to skip" patterns)

Cross-reference with coverage (if available):
- Fully covered (100%)
- Partially covered (<100%, extract uncovered lines)
- Not tested (0% or not in coverage)

5. **Present Analysis & Ask User**

Show results:
```
📊 ${MODULE}/${LAYER}

Coverage: ${TOTAL_COV}% (target: ${TARGET}%)
Gap: ${GAP}%

✅ Fully Covered:
  - File1.ts (100%)

⚠️ Partially Covered:
  - File2.ts (45%, lines 10-20, 30-40 uncovered)

❌ Not Tested:
  - File3.ts (0%)

⊘ Skip:
  - schema.ts (per strategy)

Which files to test?
1. All gaps
2. Untested only
3. Partial only
4. Custom selection
```

Wait for user response.

6. **Create Worktree**

Note the commit `git rev-parse HEAD` prints as ${BASE_SHA}, then create the worktree where git-worktree's hook allows it (`<repo>` is the repository's directory name; the new path is ${WORKTREE_PATH}) and install its dependencies, which a new worktree lacks:

```bash
git worktree add ../<repo>.wt/test/${MODULE}-${LAYER}-coverage -b test/${MODULE}-${LAYER}-coverage
pnpm install --frozen-lockfile --dir ../<repo>.wt/test/${MODULE}-${LAYER}-coverage
```

7. **Spawn Testing Agent**

```typescript
Agent({
  subagent_type: 'general-purpose',
  description: 'Test ${MODULE}/${LAYER}',
  prompt: `
Test the ${LAYER} layer of ${MODULE} module.

Strategy: Read ${PLAYBOOK_PATH}
Files: ${SELECTED_FILES}
Target: ${COVERAGE_TARGET}%
Working directory: ${WORKTREE_PATH}

Follow strategy principles.
Never modify production code.
Create single commit when done.

Report:
- Coverage achieved
- Tests created
- Any issues
`
})
```

Wait for agent completion.

8. **Verify Results**

<verification>
Run quality gates in ${WORKTREE_PATH}, where the agent committed, before completing:

```bash
# 1. Tests pass
pnpm test ${FILES}

# 2. Coverage meets target
pnpm test ${FILES} --coverage
# Parse and verify >= target

# 3. No production code changes since the worktree branched
git diff --name-only ${BASE_SHA}..HEAD | grep -v test | wc -l  # Should be 0

# 4. Type check passes
pnpm typecheck

# 5. Lint passes
pnpm lint
```

All five gates must pass before proceeding to report.
</verification>

9. **Report**

```
✅ Testing Complete: ${MODULE}/${LAYER}

Coverage: ${BEFORE}% → ${AFTER}% (+${DELTA}%)
Tests: ${COUNT} new tests
Files: ${FILES_TESTED}
Commit: ${COMMIT_HASH}

Quality Gates:
✅ All tests passing
✅ Coverage target met
✅ No production changes
✅ Type check passing
✅ Lint passing

Next steps:
- Review tests in worktree
- Merge: git rebase ${BRANCH}
- Or: Continue testing other layers
```

</workflow>
