# Orchestration Workflow Overview (v2.1)

## Visual Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ORCHESTRATION WORKFLOW v2.1 (3 PHASES)                   │
│                           COMPLEX-ONLY WORKFLOW                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: UNDERSTAND & PLAN                                                  │
│ ──────────────────────────                                                  │
│                                                                             │
│ 1. Create TodoWrite with 3 phases                                           │
│ 2. Inline exploration (Glob/Grep/Read) - NO explorer agents                 │
│ 3. Ask clarifying questions if ambiguous                                    │
│ 4. Define 2-4 independent chunks                                            │
│                                                                             │
│ 5. Spawn 2-3 Opus architect agents in parallel:                             │
│                                                                             │
│    ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │
│    │  Architect 1    │  │  Architect 2    │  │  Architect 3    │            │
│    │  Minimal        │  │  Clean          │  │  Pragmatic      │            │
│    │  Changes        │  │  Architecture   │  │  Balance        │            │
│    └────────┬────────┘  └────────┬────────┘  └────────┬────────┘            │
│             │                    │                    │                     │
│             └────────────────────┼────────────────────┘                     │
│                                  │                                          │
│                                  ▼                                          │
│                        Form Consensus                                       │
│                   (Synthesize ONE approach)                                 │
│                                                                             │
│ 6. Create base branch (feat/*, fix/*, etc.)                                 │
│ 7. Present strategy to user                                                 │
│                                                                             │
│ ✋ CHECKPOINT: APPROVE EXECUTION? (yes/no)                                   │
│    Yes → Phase 2 begins                                                     │
│    No  → Revise or abort                                                    │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: EXECUTE                                                            │
│ ────────────────                                                            │
│                                                                             │
│ **CRITICAL:** Orchestrator MUST delegate (never implements directly)        │
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
│ NO CHECKPOINT (flows to Phase 3)                                            │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: REVIEW & SHIP                                                      │
│ ──────────────────────                                                      │
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
│    • Key decisions                                                          │
│    • Chunks executed                                                        │
│    • Files modified                                                         │
│    • PR URL                                                                 │
│                                                                             │
│ DONE!                                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Checkpoint Summary

### v2.1 Checkpoints (1 Essential)

| Phase | Checkpoint | Type |
|-------|------------|------|
| Phase 1 | **Approve execution?** | ✋ ESSENTIAL |
| Phase 2 | None (unless errors) | ⚠️ CONDITIONAL |
| Phase 3 | None (unless HIGH severity) | ⚠️ CONDITIONAL |

### Checkpoint Types

**✋ ESSENTIAL** (always stop):
- **Phase 1**: Approve execution - last gate before costly work

**⚠️ CONDITIONAL** (only if issues):
- **Phase 2**: Implementation errors - if agents fail
- **Phase 3**: Quality review - only if HIGH severity bugs found

---

## Typical Flows

### High-Trust Flow
**Checkpoints**: Phase 1 only = **1 STOP**

- Phase 1: Explores, architects consensus, user approves
- Phase 2: Implements without issues
- Phase 3: No HIGH severity → auto-proceeds to PR

### Standard Flow with Issues
**Checkpoints**: Phase 1 + Phase 3 = **2 STOPS**

- Phase 1: User approves execution
- Phase 3: HIGH severity found → must decide

### Error Flow
**Checkpoints**: Phase 1 + Phase 2 + Phase 3 = **3 STOPS**

- Phase 1: User approves
- Phase 2: Agent failures → must retry/abort
- Phase 3: HIGH severity bugs → must fix

**AVERAGE**: 1-2 stops

---

## Agent Architecture

### Flat Spawning Model

```
Main Orchestrator (commands/orc.md)
    │
    ├─► Architect Agents (2-3, Opus model)
    │       └─ Returns architecture proposals → Orchestrator forms consensus
    │
    ├─► Planning Coordinator
    │       └─ Creates worktrees, returns YAML plan
    │
    ├─► Implementation Agents (N, one per chunk)
    │       └─ Work in parallel worktrees
    │
    ├─► Merge Coordinator
    │       └─ Merges sequentially, resolves conflicts
    │
    └─► Reviewer Agent(s) (1-2)
            └─ Returns findings by severity
```

**Key principle**: Main orchestrator spawns ALL agents directly. No subagent spawns other subagents.

### Agent Roles

| Agent | Responsibility |
|-------|----------------|
| **Architect** | Design approaches with different focuses (Opus model) |
| **Planning Coordinator** | Create worktrees, return execution plan |
| **Implementation** | Implement assigned chunk in worktree |
| **Merge Coordinator** | Merge worktrees, resolve conflicts |
| **Reviewer** | Find bugs, quality issues |

### Agent Models

| Agent | Model | Rationale |
|-------|-------|-----------|
| Architect | **Opus** | Better design reasoning, consensus formation |
| Others | Default | Standard implementation/review tasks |

---

## Key Changes from v2.0

### Phase Consolidation

| v2.0 (4 phases) | v2.1 (3 phases) |
|-----------------|-----------------|
| Phase 1: Understand | → Phase 1: Understand & Plan |
| Phase 2: Plan | → Phase 1: Understand & Plan |
| Phase 3: Execute | → Phase 2: Execute |
| Phase 4: Review | → Phase 3: Review & Ship |

### Removed: BASE Path

v2.1 is **COMPLEX-only**. For simple tasks, use Opus directly without /orc.

| v2.0 | v2.1 |
|------|------|
| BASE + COMPLEX paths | COMPLEX only |
| Inline architecture design | Always architect agents |
| Single implementation agent option | Always parallel worktrees |
| Classification step | No classification needed |

---

## Phase Details

### Phase 1: Understand & Plan
- **FIRST STEP:** Create TodoWrite with 3 phases
- Inline exploration using Glob/Grep/Read (no explorer agents)
- Ask clarifying questions if needed (inline, no mandatory stop)
- Define 2-4 independent chunks
- Spawn 2-3 Opus architect agents, form consensus
- Create base branch (feat/*, fix/*, etc.)
- Present strategy
- **✋ CHECKPOINT**: Approve execution? (ESSENTIAL)

### Phase 2: Execute
- **CRITICAL:** Orchestrator MUST delegate (never implements directly)
- Step 1: Planning coordinator creates worktrees
- Step 2: Parallel implementation agents (one per chunk)
- Step 3: Merge coordinator merges sequentially
- **⚠️ CONDITIONAL**: Only stop if implementation errors

### Phase 3: Review & Ship
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
| `commands/orc.md` | Main workflow (3 phases) |
| `agents/architect.md` | Architecture design (Opus model) |
| `agents/planning-coordinator.md` | Worktree creation, execution plan |
| `agents/implementation.md` | Chunk implementation in worktree |
| `agents/merge-coordinator.md` | Sequential merge, conflict resolution |

---

## Git Workflow Notes

### Quality Enforcement
Pre-commit and pre-push hooks automatically run linting, type checking, and tests. **You don't need to run these manually.**

### Worktree Isolation
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

Phase 1: UNDERSTAND & PLAN
  └─ Explore inline
  └─ Define chunks
  └─ Spawn Opus architects → Form consensus
  └─ ✋ CHECKPOINT: Approve?

Phase 2: EXECUTE
  └─ Planning coordinator → Creates worktrees
  └─ Parallel implementation agents
  └─ Merge coordinator → Merges sequentially

Phase 3: REVIEW & SHIP
  └─ 1-2 reviewers
  └─ Create PR
  └─ Done!
```
