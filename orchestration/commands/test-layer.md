---
description: Test architectural layer (delegates to layer-testing skill)
argument-hint: <module> <layer> [playbook] [--coverage <percent>] [--interactive]
---

# Test Layer Command

Explicit wrapper for the layer-testing skill. Use this command to manually trigger layer testing, or just ask naturally and the skill will activate automatically.

---

## Usage

**Explicit invocation:**
```
/test-layer <module> <layer> [OPTIONS]
```

**Options:**
- `PLAYBOOK_PATH` - Path to custom playbook file (use quotes if path has spaces)
- `--coverage <percent>` - Override coverage target
- `--interactive` - Force interactive file selection

**Examples:**
```bash
# Use default strategy file (.claude/testing-strategy.md)
/test-layer photoshoot core

# Use custom playbook
/test-layer auth application docs/testing-playbook.md
/test-layer auth application "docs/testing/module-testing-playbook.md"

# Override coverage target
/test-layer auth application --coverage 85

# Interactive mode with playbook
/test-layer user infrastructure playbook.md --interactive

# All options combined
/test-layer photoshoot core docs/guide.md --coverage 100
```

**Natural invocation** (skill activates automatically):
- "Test the core layer using my playbook file"
- "I need comprehensive tests for the application layer"
- "Generate tests for auth/infrastructure with my testing guide"

---

## What This Command Does

This command delegates to the **layer-testing skill**, which:

1. **Reads testing strategy** from `.claude/testing-strategy.md`
2. **Analyzes the target layer** (files, current coverage, what to test)
3. **Creates isolated worktree** for safe parallel work
4. **Spawns testing agent** with layer-specific strategy
5. **Verifies quality gates** (coverage, tests passing, no production changes)
6. **Provides recommendations** for next steps

---

## Prerequisites

### Required: Testing Strategy File

The layer-testing skill requires `.claude/testing-strategy.md` in your project root.

**If missing**, run:
```
/setup-testing-strategy
```

This will interactively create the strategy file for your project.

**Why required**: Different projects use different architectures (hexagonal, clean, layered, custom). The strategy file defines your project's testing approach, making the skill architecture-agnostic.

---

## Workflow (4 Phases)

### Phase 1: Strategy & Analysis
- Reads `.claude/testing-strategy.md`
- Scans target layer directory
- Categorizes files (testable vs skip)
- Calculates coverage gap
- Presents analysis and gets your approval

### Phase 2: Execute
- Creates worktree: `test/{module}-{layer}-coverage`
- Spawns testing specialist agent
- Agent works autonomously in isolation
- You can continue working in main repository

### Phase 3: Review
- Verifies 5 quality gates:
  1. Coverage >= target
  2. All tests passing
  3. Zero production code changes
  4. Type-check passing
  5. Lint passing
- Presents comprehensive summary

### Phase 4: Next Steps
- Recommends next layer to test
- Provides merge instructions
- Calculates overall module progress

---

## Your Task

Activate the layer-testing skill with the provided arguments:

**Arguments to pass:**
- MODULE: `$1` (first argument)
- LAYER: `$2` (second argument)
- PLAYBOOK: `$3` if it's a file path (e.g., `docs/playbook.md`), otherwise use `.claude/testing-strategy.md`
- COVERAGE: Extract from `--coverage <N>` flag if present, otherwise use default (100% ideal)
- INTERACTIVE: Check for `--interactive` flag

**Execution:**

Invoke the layer-testing skill and execute it with these arguments, following the skill's 4-phase **interactive** workflow exactly as documented in:

`orchestration/skills/layer-testing/SKILL.md`

The skill will:
1. Read playbook file (if provided) or `.claude/testing-strategy.md`
2. Analyze files and ASK user which to test (interactive)
3. Spawn agent with user-selected files
4. Report results including unreachable code findings

Your role is to facilitate the skill activation and pass the correct arguments.

---

## Troubleshooting

**"Testing strategy file not found"**
→ Run `/setup-testing-strategy` to create one

**"Layer not found: {module}/{layer}"**
→ Check module and layer names (case-sensitive)
→ Verify path patterns in strategy file

**"Coverage target unreachable"**
→ Lower target: `/test-layer {module} {layer} --coverage 70`
→ Or accept current coverage with justification

**"Worktree path already exists"**
→ Previous run didn't clean up
→ Remove it: `rm -rf path` or `git worktree remove path --force`

**"Agent modified production code"**
→ Quality gate 3 failed
→ Reject the commit, re-run with stricter instructions

---

## Documentation

**For detailed information:**
- **Skill documentation**: `orchestration/skills/layer-testing/SKILL.md`
- **Workflow phases**: `orchestration/skills/layer-testing/references/workflow-phases.md`
- **Quality gates**: `orchestration/skills/layer-testing/references/quality-gates.md`
- **Testing patterns**: See example strategies in `orchestration/skills/layer-testing/templates/examples/`

---

## Notes

- This command is just a thin wrapper for explicit invocation
- The skill can also activate automatically when you ask naturally
- The skill is architecture-agnostic (hexagonal, clean, layered, custom)
- All testing logic lives in the skill, not this command
- The skill creates isolated worktrees for safe parallel work
