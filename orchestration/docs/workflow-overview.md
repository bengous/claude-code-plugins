# Orchestration Workflow Overview

## Visual Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ORCHESTRATION WORKFLOW (TIERED APPROVALS)                │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Discovery                                                          │
│ ─────────────────                                                           │
│ • **CRITICAL FIRST STEP: Create TodoWrite** with all 8 phases               │
│ • Understand feature request                                                │
│ • Ask clarifying questions if unclear                                       │
│ • Summarize understanding                                                   │
│                                                                             │
│ NO CHECKPOINT (context setting only)                                        │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Codebase Exploration                                               │
│ ─────────────────────────────                                               │
│ Spawn 2-3 code-explorer agents in PARALLEL                                  │
│                                                                             │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│   │ Explorer A   │  │ Explorer B   │  │ Explorer C   │                      │
│   │ Similar      │  │ Architecture │  │ Testing      │                      │
│   │ Features     │  │ Patterns     │  │ Conventions  │                      │
│   └──────────────┘  └──────────────┘  └──────────────┘                      │
│                                                                             │
│ • Read all identified files                                                 │
│ • Present comprehensive findings                                            │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: Clarifying Questions                                               │
│ ─────────────────────────────                                               │
│ • Identify underspecified aspects                                           │
│ • Present organized list of questions                                       │
│                                                                             │
│ CHECKPOINT 1: WAIT FOR USER ANSWERS (ESSENTIAL)                             │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: Architecture Design                                                │
│ ─────────────────────────────                                               │
│ Spawn 2-3 code-architect agents in PARALLEL                                 │
│                                                                             │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│   │ Architect A  │  │ Architect B  │  │ Architect C  │                      │
│   │ Minimal      │  │ Clean        │  │ Pragmatic    │                      │
│   │ Changes      │  │ Architecture │  │ Balance      │                      │
│   └──────────────┘  └──────────────┘  └──────────────┘                      │
│                                                                             │
│ • Present recommendation with rationale                                     │
│                                                                             │
│ ADAPTIVE: User can say "sounds good" to proceed                             │
│              Or engage to discuss alternatives                              │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: Classification & Execution Strategy                                │
│ ────────────────────────────────────────────                                │
│ 1. Create base branch: feat/*, fix/*, refactor/*, chore/*                   │
│ 2. Assess parallelization potential                                         │
│ 3. Classify execution path (BASE or COMPLEX)                                │
│ 4. Present strategy with chunk breakdown                                    │
│                                                                             │
│ CHECKPOINT 2: APPROVE EXECUTION? (ESSENTIAL)                                │
│    Yes → Phase 6 begins immediately                                         │
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
                              BASE PATH (Single Agent)
═════════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 6A: BASE Implementation                                               │
│ ─────────────────────────────                                               │
│ (Begins immediately after Phase 5 approval)                                 │
│                                                                             │
│  **CRITICAL:** Orchestrator MUST delegate to subagent (never implements)    │
│                                                                             │
│  Main Orchestrator                                                          │
│                                                                             │
│         │ Spawn single implementation agent (Task tool)                     │
│         ▼                                                                   │
│  ┌──────────────────────────────┐                                           │
│  │  Implementation Agent        │                                           │
│  │  ──────────────────────       │                                          │
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
│ NO CHECKPOINT (flows to Phase 7)                                            │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 │
═════════════════════════════════════════════════════════════════════════════
                           COMPLEX PATH (Multi-Agent Parallel)
═════════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 6B: COMPLEX Implementation                                            │
│ ────────────────────────────────                                            │
│ (Begins immediately after Phase 5 approval)                                 │
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
│ │   │  ─────────────────────        │                                   │   │
│ │   │  • Creates worktrees         │                                    │   │
│ │   │  • Gets paths/branches       │                                    │   │
│ │   │  • Analyzes dependencies     │                                    │   │
│ │   │  • Returns YAML plan         │                                    │   │
│ │   └──────────────────────────────┘                                    │   │
│ │          │                                                            │   │
│ │          │ Returns execution plan                                     │   │
│ │          ▼                                                            │   │
│ │   Main Orchestrator                                                   │   │
│ │   • Reviews plan                                                      │   │
│ │   • Creates TodoWrite                                                 │   │
│ │                                                                       │   │
│ │   NO CHECKPOINT (flows to Step 2)                                     │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ STEP 2: Implementation (PARALLEL)                                     │   │
│ │ ──────────────────────────────                                        │   │
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
│ │   │      │  Each agent works in isolated worktree    │                │   │
│ │   │      │                                            │               │   │
│ │   └──────┴──────────────┴──────────────┴──────────────┘               │   │
│ │          │                                                            │   │
│ │          │ All agents return completion summaries                     │   │
│ │          ▼                                                            │   │
│ │   Main Orchestrator                                                   │   │
│ │   • Reviews all summaries                                             │   │
│ │   • Checks for errors                                                 │   │
│ │                                                                       │   │
│ │   CONDITIONAL: If blocking errors → STOP, inform user                 │   │
│ │                   If success → proceed to Step 3                      │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ STEP 3: Merging (SEQUENTIAL)                                          │   │
│ │ ─────────────────────────                                             │   │
│ │                                                                       │   │
│ │   Main Orchestrator                                                   │   │
│ │          │                                                            │   │
│ │          │ Spawn merge coordinator                                    │   │
│ │          ▼                                                            │   │
│ │   ┌──────────────────────────────┐                                    │   │
│ │   │  Merge Coordinator           │                                    │   │
│ │   │  ──────────────────           │                                   │   │
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
│ │   • Updates TodoWrite                                                 │   │
│ │                                                                       │   │
│ │   NO CHECKPOINT (flows to Phase 7)                                    │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 │
═════════════════════════════════════════════════════════════════════════════
                         Both paths converge here
═════════════════════════════════════════════════════════════════════════════
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 7: Quality Review                                                     │
│ ──────────────────────                                                      │
│ **CRITICAL: ALWAYS run this phase** (even for simple BASE tasks)            │
│                                                                             │
│ **Adaptive Sizing:**                                                        │
│ • BASE path: Spawn 1-2 reviewers (simplicity + bugs)                        │
│ • COMPLEX path: Spawn 3 reviewers (simplicity + bugs + integration)         │
│                                                                             │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│   │ Reviewer A   │  │ Reviewer B   │  │ Reviewer C   │                      │
│   │ Simplicity   │  │ Bugs &       │  │ (COMPLEX     │                      │
│   │ DRY/Elegance │  │ Correctness  │  │ only)        │                      │
│   └──────────────┘  └──────────────┘  └──────────────┘                      │
│                                                                             │
│ • Consolidate findings                                                      │
│ • Categorize by severity: HIGH / MEDIUM / LOW                               │
│                                                                             │
│ CONDITIONAL CHECKPOINT:                                                     │
│    • HIGH severity (bugs/broken) → STOP, ask user what to do                │
│    • MEDIUM/LOW severity → Report but proceed automatically                 │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 8: Final PR & Summary                                                 │
│ ───────────────────────────                                                 │
│ • Create single PR from base branch to dev                                  │
│ • Mark all TodoWrite items complete                                         │
│ • Summarize what was built                                                  │
│ • Done!                                                                     │
│                                                                             │
│ NO CHECKPOINT (completion)                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Approval Checkpoint Summary

### Checkpoint Types

**✋ ESSENTIAL** (always stop):
1. **Phase 3**: Clarifying questions - need information to proceed
2. **Phase 5**: Execution approval - last gate before costly work

**💬 ADAPTIVE** (can skip):
3. **Phase 4**: Architecture choice - user can say "sounds good"

**⚠️ CONDITIONAL** (only if issues):
4. **Phase 6B**: Implementation errors - only if agents fail
5. **Phase 7**: Quality review - only if HIGH severity bugs found

**✅ REMOVED**:
- ❌ Phase 1: Confirmation (non-blocking context)
- ❌ Phase 6: Implementation approval (merged with Phase 5)
- ❌ Phase 7: All quality issues (now severity-based)

---

## Typical Flows

### 🟢 High-Trust Flow (user trusts orchestrator)
**Checkpoints**: Phase 3 + Phase 5 = **2 STOPS**

- Phase 4: "Sounds good" → proceeds
- Phase 7: No HIGH severity → auto-proceeds

### 🟡 Standard Flow (some engagement)
**Checkpoints**: Phase 3 + Phase 4 + Phase 5 + Phase 7 = **3-4 STOPS**

- Phase 4: Discusses alternatives
- Phase 7: HIGH severity found → must decide

### 🔴 Error Flow (things go wrong)
**Checkpoints**: All + Phase 6B errors = **4-5 STOPS**

- Phase 4: Discusses alternatives
- Phase 6B: Agent failures → must retry/abort
- Phase 7: HIGH severity bugs → must fix

**AVERAGE**: 2-3 stops (down from 7) = **57-71% REDUCTION**

---

## Agent Architecture

### Flat Spawning Model (No Hierarchy)

```
Main Orchestrator (commands/orc.md)
    ├─► Planning Coordinator (subagent) - creates worktrees, returns plan
    ├─► Implementation Agent A (subagent) - implements chunk A
    ├─► Implementation Agent B (subagent) - implements chunk B
    ├─► Implementation Agent C (subagent) - implements chunk C
    └─► Merge Coordinator (subagent) - merges + resolves conflicts inline
```

**Key principle**: Main orchestrator spawns ALL agents directly. No subagent spawns other subagents.

### Agent Roles

| Agent | Responsibility | Spawns Others? |
|-------|---------------|----------------|
| **Main Orchestrator** | Controls workflow, spawns all agents | ✅ Yes (all below) |
| **Planning Coordinator** | Creates worktrees, returns YAML plan | ❌ No |
| **Implementation Agents** | Implement chunks in isolated worktrees | ❌ No |
| **Merge Coordinator** | Merges worktrees, resolves conflicts inline | ❌ No |

---

## Key Improvements

✅ **Less friction** for trusted workflows
✅ **Self-adjusting** based on user engagement
✅ **Still safe** (stops before execution + on critical issues)
✅ **Better UX** without sacrificing safety
✅ **Flat agent spawning** (no hierarchical uncertainty)
✅ **Severity-based quality review** (only stop on bugs)

---

## Phase Details

### Phase 1: Discovery
- **CRITICAL FIRST STEP:** Create TodoWrite with all 8 phases
- Understand feature request
- Ask clarifying questions if unclear
- Summarize understanding
- **No checkpoint** (context setting only)

### Phase 2: Codebase Exploration
- Spawn 2-3 code-explorer agents in parallel
- Read identified files
- Present comprehensive findings
- **No checkpoint** (information gathering)

### Phase 3: Clarifying Questions
- Identify underspecified aspects
- Present organized questions
- **✋ CHECKPOINT**: Wait for user answers (ESSENTIAL)

### Phase 4: Architecture Design
- Spawn 2-3 code-architect agents in parallel
- Present recommendation with rationale
- **💬 ADAPTIVE**: User can say "sounds good" to proceed

### Phase 5: Classification & Execution Strategy
- Create base branch
- Assess parallelization potential
- Classify as BASE or COMPLEX
- Present strategy
- **✋ CHECKPOINT**: Approve execution? (ESSENTIAL)

### Phase 6A: BASE Implementation
- Begins immediately after Phase 5 approval
- **CRITICAL:** Orchestrator MUST spawn implementation agent (never implements directly)
- Agent creates internal TodoWrite
- Agent works on base branch
- **No checkpoint** (flows to Phase 7)

### Phase 6B: COMPLEX Implementation
- Begins immediately after Phase 5 approval
- **Step 1**: Planning coordinator creates worktrees + plan
- **Step 2**: Implementation agents work in parallel
  - **⚠️ CONDITIONAL**: If errors → STOP, inform user
- **Step 3**: Merge coordinator merges sequentially
- **No checkpoint** unless errors (flows to Phase 7)

### Phase 7: Quality Review
- **CRITICAL: ALWAYS run this phase** (mandatory for both BASE and COMPLEX)
- **Adaptive sizing:**
  - BASE path: Spawn 1-2 code-reviewer agents (simplicity + bugs)
  - COMPLEX path: Spawn 3 code-reviewer agents (simplicity + bugs + integration)
- Categorize by severity: HIGH / MEDIUM / LOW
- **⚠️ CONDITIONAL**: Only stop if HIGH severity issues

### Phase 8: Final PR & Summary
- Create single PR
- Mark TodoWrite complete
- Summarize accomplishments
- **No checkpoint** (completion)

---

## Workflow Enforcement (Added in v0.2.0)

### TodoWrite Tracking (Phase 1)
**Enforced:** Orchestrator MUST create TodoWrite list with all 8 phases as first action.

**Why critical:**
- Progress visibility for user
- Prevents phase skipping
- Enables checkpoint tracking
- Required for proper orchestration

**Example format:**
```
- Phase 1: Discovery
- Phase 2: Codebase Exploration
- Phase 3: Clarifying Questions
- Phase 4: Architecture Design
- Phase 5: Classification & Execution Strategy
- Phase 6: Implementation
- Phase 7: Quality Review
- Phase 8: Final PR & Summary
```

### Subagent Delegation (Phase 6 BASE)
**Enforced:** Orchestrator MUST delegate to implementation agent, never implements directly.

**Why critical:**
- Separation of concerns: Coordinator vs Worker
- Consistent delegation model across BASE and COMPLEX
- Subagents can use internal TodoWrite
- Maintains workflow integrity

**What changed:**
- **Before:** Orchestrator sometimes implemented code directly (~100% for simple tasks)
- **After:** Orchestrator always spawns implementation agent (0% direct implementation)

### Mandatory Quality Review (Phase 7)
**Enforced:** Phase 7 ALWAYS runs, even for simple BASE tasks.

**Adaptive sizing:**
- BASE: 1-2 reviewers (fast, focused)
- COMPLEX: 3 reviewers (thorough, integration-aware)

**Why critical:**
- Git hooks catch syntax/type errors, not design issues
- Prevents technical debt accumulation
- Finds redundancy, complexity, subtle bugs

**What changed:**
- **Before:** Phase 7 skipped ~70% of time for BASE tasks
- **After:** Phase 7 always runs (adaptive sizing for efficiency)

### Subagent Internal TodoWrite
**Recommended:** All subagents should create internal TodoWrite to track their work.

**Benefits:**
- Keeps agents organized
- Prevents forgetting steps
- Shows thoroughness
- Helps recover from context limits

**Applies to:**
- Implementation agents (Phase 6)
- Planning coordinator (Phase 6B)
- Merge coordinator (Phase 6B)

---

## Git Workflow Notes

### Quality Enforcement
Pre-commit and pre-push hooks automatically run:
- Linting (biome, eslint, etc.)
- Type checking (tsc)
- Tests (vitest, playwright)
- Custom validation

**You don't need to run these manually.** They happen automatically on commit/push.

### Worktree Isolation (COMPLEX Path Only)
The `worktree-guard.py` hook ensures agents don't run commands in wrong worktrees. This is a **safety mechanism** (blocks dangerous operations), not workflow enforcement.

### State Management
Use TodoWrite exclusively for tracking progress. No JSON files, no marker files, no custom state.

### Agent Communication
All subagents are stateless:
- Cannot access parent's TodoWrite
- Cannot be messaged after spawning
- Communicate ONLY via final return message
- Parent receives return message and proceeds

### Concurrency Model
No locks needed. Worktrees provide isolation. Trust orchestration not to create duplicate worktrees.

---

## Implementation Files

- **Main workflow**: `commands/orc.md`
- **Planning coordinator**: `agents/planning-coordinator.md`
- **Implementation agent**: `agents/implementation.md`
- **Merge coordinator**: `agents/merge-coordinator.md`
