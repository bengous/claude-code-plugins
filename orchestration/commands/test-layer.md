---
description: Test architectural layer with coverage-first analysis
argument-hint: <module> <layer> [playbook] [--coverage <percent>]
---

# Test Layer

Test a specific architectural layer with comprehensive coverage analysis.

## Usage

```bash
/test-layer <module> <layer> [playbook] [--coverage <N>]
```

**Examples:**
```bash
/test-layer auth infrastructure
/test-layer auth infrastructure docs/playbook.md
/test-layer auth infrastructure docs/playbook.md --coverage 80
```

**Natural invocation:**
- "Test the infrastructure layer of auth"
- "Test auth/infrastructure with my playbook"

---

## Your Task

**Step 1: Parse Arguments**

Extract from `$ARGUMENTS`:
- MODULE: `$1`
- LAYER: `$2`
- PLAYBOOK: `$3` (optional)
- COVERAGE: from `--coverage <N>` flag (optional)

**Step 2: Invoke Skill**

```
Skill(skill: "layer-testing")
```

**Step 3: Provide Context**

```
Testing Request:
- Module: <MODULE>
- Layer: <LAYER>
- Playbook: <PLAYBOOK or "none">
- Coverage Target: <COVERAGE or "100">%
```

Done. The skill handles the rest.
