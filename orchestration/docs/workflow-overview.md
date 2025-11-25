# Orchestration Workflow Overview (v2.0)

## Visual Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ORCHESTRATION WORKFLOW v2.0 (4 PHASES)                   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: UNDERSTAND                                                         │
│ ───────────────────                                                         │
│ • Create TodoWrite with 4 phases                                            │
│ • Inline exploration (Glob/Grep/Read) - NO explorer agents                  │
│ • Ask clarifying questions if ambiguous                                     │
│ • Classify as BASE or COMPLEX                                               │
│                                                                             │
│ Classification Heuristics:                                                  │
│   BASE: Single module, cohesive feature, no parallelization benefit         │
│   COMPLEX: Multi-module, backend+frontend+db, can split into chunks         │
│                                                                             │
│ NO CHECKPOINT (understanding phase)                                         │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: PLAN                                                               │
│ ─────────────                                                               │
│ 1. Create base branch: feat/*, fix/*, refactor/*, chore/*                   │
│                                                                             │
│ 2. Architecture Design (differs by path):                                   │
│                                                                             │
│    ┌─────────────────────────┐    ┌─────────────────────────────────────┐   │
│    │ BASE PATH               │    │ COMPLEX PATH                        │   │
│    │ ───────────             │    │ ────────────                        │   │
│    │ Design inline           │    │ Spawn 2-3 architect agents (Opus)   │   │
│    │ (no architect agents)   │    │                                     │   │
│    │                         │    │  ┌────────┐ ┌────────┐ ┌────────┐   │   │
│    │ Present single          │    │  │Minimal │ │ Clean  │ │Pragmat.│   │   │
│    │ recommended approach    │    │  │Changes │ │  Arch  │ │Balance │   │   │
│    │                         │    │  └────────┘ └────────┘ └────────┘   │   │
│    │                         │    │                                     │   │
│    │                         │    │  Form consensus: synthesize ONE     │   │
│    │                         │    │  recommended approach               │   │
│    └─────────────────────────┘    └─────────────────────────────────────┘   │
│                                                                             │
│ 3. For COMPLEX: Define chunk breakdown with file boundaries                 │
│                                                                             │
│ 4. Present strategy                                                         │
│                                                                             │
│ ✋ CHECKPOINT: APPROVE EXECUTION? (yes/no)                                   │
│    Yes → Phase 3 begins immediately                                         │
│    No  → Revise or abort                                                    │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                    ▼                         ▼
        ┌─────────────────────┐   ┌─────────────────────┐
        │   BASE PATH         │   │   COMPLEX PATH      │
        │   (Single Agent)    │   │   (Multi-Agent)     │
        └─────────────────────┘   └─────────────────────┘

═════════════════════════════════════════════════════════════════════════════
                              BASE PATH
═════════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3A: BASE EXECUTE                                                      │
│ ──────────────────────                                                      │
│ (Begins immediately after Phase 2 approval)                                 │
│                                                                             │
│  **CRITICAL:** Orchestrator MUST delegate (never implements directly)       │
│                                                                             │
│  Main Orchestrator                                                          │
│                                                                             │
│         │ Spawn single implementation agent                                 │
│         ▼                                                                   │
│  ┌──────────────────────────────┐                                           │
│  │  Implementation Agent        │                                           │
│  │  ─────────────────────       │                                           │
│  │  • Creates internal TodoWrite│                                           │
│  │  • Works on base branch      │                                           │
│  │  • Implements full feature   │                                           │
│  │  • Returns completion        │                                           │
│  └──────────────────────────────┘                                           │
│                                                                             │
│         │ Returns completion summary                                        │
│         ▼                                                                   │
│  Main Orchestrator                                                          │
│                                                                             │
│ NO CHECKPOINT (flows to Phase 4)                                            │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 │
═════════════════════════════════════════════════════════════════════════════
                           COMPLEX PATH
═════════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3B: COMPLEX EXECUTE                                                   │
│ ─────────────────────────                                                   │
│ (Begins immediately after Phase 2 approval)                                 │
│                                                                             │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ STEP 1: Planning                                                      │   │
│ │ ────────────────                                                      │   │
│ │                                                                       │   │
│ │   Main Orchestrator                                                   │   │
│ │          │                                                            │   │
│ │          │ Spawn planning coordinator                                 │   │
│ │          ▼                                                            │   │
│ │   ┌──────────────────────────────┐                                    │   │
│ │   │  Planning Coordinator        │                                    │   │
│ │   │  ─────────────────────       │                                    │   │
│ │   │  • Creates worktrees         │                                    │   │
│ │   │  • Gets paths/branches       │                                    │   │
│ │   │  • Analyzes dependencies     │                                    │   │
│ │   │  • Returns YAML plan         │                                    │   │
│ │   └──────────────────────────────┘                                    │   │
│ │          │                                                            │   │
│ │          │ Returns execution plan                                     │   │
│ │          ▼                                                            │   │
│ │   Main Orchestrator reviews plan                                      │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ STEP 2: Parallel Implementation                                       │   │
│ │ ───────────────────────────────                                       │   │
│ │                                                                       │   │
│ │   Main Orchestrator                                                   │   │
│ │          │                                                            │   │
│ │          │ Spawn all implementation agents in PARALLEL                │   │
│ │          │                                                            │   │
│ │   ┌──────┼──────────────┬──────────────┬──────────────┐               │   │
│ │   │      │              │              │              │               │   │
│ │   ▼      ▼              ▼              ▼              ▼               │   │
│ │ ┌────┐ ┌────┐         ┌────┐        ┌────┐        ┌────┐              │   │
│ │ │ A  │ │ B  │   ...   │ C  │        │ D  │        │ N  │              │   │
│ │ └────┘ └────┘         └────┘        └────┘        └────┘              │   │
│ │   │      │              │              │              │               │   │
│ │   │      │  Each agent works in isolated worktree    │               │   │
│ │   │      │                                           │               │   │
│ │   └──────┴──────────────┴──────────────┴─────────────┘               │   │
│ │          │                                                            │   │
│ │          │ All agents return completion summaries                     │   │
│ │          ▼                                                            │   │
│ │   Main Orchestrator reviews summaries                                 │   │
│ │                                                                       │   │
│ │   ⚠️ CONDITIONAL: If blocking errors → STOP, inform user              │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ STEP 3: Sequential Merging                                            │   │
│ │ ──────────────────────────                                            │   │
│ │                                                                       │   │
│ │   Main Orchestrator                                                   │   │
│ │          │                                                            │   │
│ │          │ Spawn merge coordinator                                    │   │
│ │          ▼                                                            │   │
│ │   ┌──────────────────────────────┐                                    │   │
│ │   │  Merge Coordinator           │                                    │   │
│ │   │  ──────────────────          │                                    │   │
│ │   │  • Verifies completions      │                                    │   │
│ │   │  • Merges sequentially       │                                    │   │
│ │   │  • Resolves conflicts inline │                                    │   │
│ │   │  • Cleans up worktrees       │                                    │   │
│ │   │  • Returns summary           │                                    │   │
│ │   └──────────────────────────────┘                                    │   │
│ │          │                                                            │   │
│ │          │ Returns merge completion                                   │   │
│ │          ▼                                                            │   │
│ │   Main Orchestrator                                                   │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ NO CHECKPOINT (flows to Phase 4)                                            │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 │
═════════════════════════════════════════════════════════════════════════════
                         Both paths converge here
═════════════════════════════════════════════════════════════════════════════
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: REVIEW                                                             │
│ ───────────────                                                             │
│                                                                             │
│ 1. Quality Review                                                           │
│    Spawn 1-2 reviewer agents:                                               │
│                                                                             │
│    ┌──────────────┐  ┌──────────────┐                                       │
│    │ Reviewer A   │  │ Reviewer B   │                                       │
│    │ Simplicity   │  │ Bugs &       │                                       │
│    │ DRY/Elegance │  │ Correctness  │                                       │
│    └──────────────┘  └──────────────┘                                       │
│                                                                             │
│    Categorize findings by severity: HIGH / MEDIUM / LOW                     │
│                                                                             │
│    ⚠️ CONDITIONAL CHECKPOINT:                                               │
│       • HIGH severity (bugs/broken) → STOP, ask user what to do             │
│       • MEDIUM/LOW severity → Report but proceed automatically              │
│                                                                             │
│ 2. Create PR                                                                │
│    gh pr create --head <branch> --base dev                                  │
│                                                                             │
│ 3. Summary                                                                  │
│    • What was built                                                         │
│    • Classification used                                                    │
│    • Key decisions                                                          │
│    • Files modified                                                         │
│    • PR URL                                                                 │
│                                                                             │
│ DONE!                                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Checkpoint Summary

### v2.0 Checkpoints (Reduced from 3 to 1)

| Phase | Checkpoint | Type |
|-------|------------|------|
| Phase 1 | None | Understanding only |
| Phase 2 | **Approve execution?** | ✋ ESSENTIAL |
| Phase 3 | None (unless errors) | ⚠️ CONDITIONAL |
| Phase 4 | None (unless HIGH severity) | ⚠️ CONDITIONAL |

### Checkpoint Types

**✋ ESSENTIAL** (always stop):
- **Phase 2**: Approve execution - last gate before costly work

**⚠️ CONDITIONAL** (only if issues):
- **Phase 3**: Implementation errors (COMPLEX only) - if agents fail
- **Phase 4**: Quality review - only if HIGH severity bugs found

**✅ REMOVED from v1.x**:
- ❌ Phase 3: Clarifying questions (now inline in Phase 1)
- ❌ Phase 4: Architecture approval (now part of Phase 2)
- ❌ Phase 5: Classification approval (merged into Phase 2)

---

## Typical Flows

### High-Trust Flow
**Checkpoints**: Phase 2 only = **1 STOP**

- Phase 1: Explores, classifies, no stop
- Phase 2: Presents plan, user approves
- Phase 3: Implements without issues
- Phase 4: No HIGH severity → auto-proceeds

### Standard Flow with Issues
**Checkpoints**: Phase 2 + Phase 4 = **2 STOPS**

- Phase 2: User approves execution
- Phase 4: HIGH severity found → must decide

### Error Flow
**Checkpoints**: Phase 2 + Phase 3 + Phase 4 = **3 STOPS**

- Phase 2: User approves
- Phase 3: Agent failures → must retry/abort
- Phase 4: HIGH severity bugs → must fix

**AVERAGE**: 1-2 stops (down from 3 in v1.x, down from 7 in v0.x)

---

## Agent Architecture

### Flat Spawning Model

```
Main Orchestrator (commands/orc.md)
    │
    ├─► [COMPLEX only] Architect Agents (2-3, Opus model)
    │       └─ Returns architecture proposals → Orchestrator forms consensus
    │
    ├─► [COMPLEX only] Planning Coordinator
    │       └─ Creates worktrees, returns YAML plan
    │
    ├─► Implementation Agent(s)
    │       └─ BASE: 1 agent on base branch
    │       └─ COMPLEX: N agents in parallel worktrees
    │
    ├─► [COMPLEX only] Merge Coordinator
    │       └─ Merges sequentially, resolves conflicts
    │
    └─► Reviewer Agent(s) (1-2)
            └─ Returns findings by severity
```

**Key principle**: Main orchestrator spawns ALL agents directly. No subagent spawns other subagents.

### Agent Roles

| Agent | When Used | Responsibility |
|-------|-----------|----------------|
| **Architect** | COMPLEX only | Design approaches with different focuses |
| **Planning Coordinator** | COMPLEX only | Create worktrees, return execution plan |
| **Implementation** | Always | Implement feature/chunk |
| **Merge Coordinator** | COMPLEX only | Merge worktrees, resolve conflicts |
| **Reviewer** | Always | Find bugs, quality issues |

### Agent Models

| Agent | Model | Rationale |
|-------|-------|-----------|
| Architect | **Opus** | Better design reasoning, consensus formation |
| Others | Default | Standard implementation/review tasks |

---

## Key Changes from v1.x

### Phase Consolidation

| v1.x (8 phases) | v2.0 (4 phases) |
|-----------------|-----------------|
| Phase 1: Discovery | → Phase 1: Understand |
| Phase 2: Exploration | → Phase 1: Understand |
| Phase 3: Questions | → Phase 1: Understand |
| Phase 4: Architecture | → Phase 2: Plan |
| Phase 5: Classification | → Phase 2: Plan |
| Phase 6: Implementation | → Phase 3: Execute |
| Phase 7: Quality Review | → Phase 4: Review |
| Phase 8: PR & Summary | → Phase 4: Review |

### Agent Changes

| v1.x | v2.0 |
|------|------|
| 2-3 explorer agents | Inline exploration (no agents) |
| 2-3 architect agents always | Architects for COMPLEX only |
| Default model for architects | Opus model for architects |
| 1-3 reviewers | 1-2 reviewers |

### Checkpoint Changes

| v1.x | v2.0 |
|------|------|
| 3 essential checkpoints | 1 essential checkpoint |
| Stop after questions | Questions inline, no stop |
| Stop for architecture approval | Architecture in Plan phase |
| Stop for execution approval | Single approval in Phase 2 |

---

## Phase Details

### Phase 1: Understand
- **FIRST STEP:** Create TodoWrite with 4 phases
- Inline exploration using Glob/Grep/Read (no explorer agents)
- Ask clarifying questions if needed (inline, no mandatory stop)
- Classify as BASE or COMPLEX based on findings
- **No checkpoint** (understanding phase)

### Phase 2: Plan
- Create base branch (feat/*, fix/*, etc.)
- Architecture design:
  - BASE: Design inline (no architects)
  - COMPLEX: Spawn 2-3 Opus architect agents, form consensus
- For COMPLEX: Define chunk breakdown
- Present strategy
- **✋ CHECKPOINT**: Approve execution? (ESSENTIAL)

### Phase 3: Execute
- **CRITICAL:** Orchestrator MUST delegate (never implements directly)
- BASE: Single implementation agent
- COMPLEX:
  - Step 1: Planning coordinator creates worktrees
  - Step 2: Parallel implementation agents
  - Step 3: Merge coordinator merges sequentially
- **⚠️ CONDITIONAL**: Only stop if implementation errors

### Phase 4: Review
- Spawn 1-2 reviewer agents
- Categorize findings by severity
- **⚠️ CONDITIONAL**: Only stop if HIGH severity
- Create PR
- Summary
- **Done!**

---

## Implementation Files

| File | Purpose |
|------|---------|
| `commands/orc.md` | Main workflow (4 phases) |
| `agents/architect.md` | Architecture design (Opus model) |
| `agents/planning-coordinator.md` | Worktree creation, execution plan |
| `agents/implementation.md` | Feature/chunk implementation |
| `agents/merge-coordinator.md` | Sequential merge, conflict resolution |

---

## Git Workflow Notes

### Quality Enforcement
Pre-commit and pre-push hooks automatically run linting, type checking, and tests. **You don't need to run these manually.**

### Worktree Isolation (COMPLEX Only)
Each implementation agent works in an isolated git worktree with its own branch. This enables true parallel development without conflicts.

### State Management
Use TodoWrite exclusively for tracking progress. No JSON files, no marker files, no custom state.

### Agent Communication
All subagents are stateless:
- Cannot access parent's TodoWrite
- Cannot be messaged after spawning
- Communicate ONLY via final return message

---

## Quick Reference

```
/orc "Add user authentication"

Phase 1: UNDERSTAND
  └─ Explore inline → Classify BASE/COMPLEX

Phase 2: PLAN
  └─ Create branch
  └─ Architecture (inline or Opus architects)
  └─ ✋ CHECKPOINT: Approve?

Phase 3: EXECUTE
  └─ BASE: 1 implementation agent
  └─ COMPLEX: Plan → Parallel agents → Merge

Phase 4: REVIEW
  └─ 1-2 reviewers
  └─ Create PR
  └─ Done!
```
