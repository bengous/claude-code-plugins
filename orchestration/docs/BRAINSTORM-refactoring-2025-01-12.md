# Orchestration Plugin Refactoring - Brainstorming Session

**Date**: 2025-01-12
**Context**: After analyzing why the orchestration plugin doesn't work (see ANALYSIS-anthropic-feature-dev.md), we brainstormed the ideal architecture combining the best of our orchestration approach with Anthropic's proven feature-dev patterns.

---

## The Evolution of Our Thinking

### Initial Problem Recognition

The user identified the core issues with the current implementation:

1. **Hooks for workflow = wrong tool** - Hooks are for blocking dangerous operations (like `worktree-guard.py` blocking Bash in wrong worktrees), NOT for guiding agent workflow
2. **Prompt-based enforcement works** - Anthropic's bold text directives prove natural language is more reliable than technical mechanisms
3. **JSON state = unnecessary friction** - TodoWrite is simpler, visible, and built-in
4. **@ imports broken in plugins** - Fundamental limitation: they resolve relative to PROJECT, not plugin
5. **Over-engineering the structure** - Too many files, hooks, state management adds complexity without benefit
6. **Let Claude decide vs forcing structure** - More flexible, less brittle than enforcing JSON schema

### The Synthesis Insight

Original orchestration had:
- ✅ Sophisticated execution model (branching, isolation, PR safety)
- ❌ No agent delegation
- ❌ Technical enforcement that doesn't work
- ❌ Hidden state management

Anthropic's feature-dev had:
- ✅ Sophisticated analysis model (agent delegation, architecture design, quality review)
- ✅ Natural language enforcement that works
- ✅ Visible state (TodoWrite)
- ❌ No isolation strategy
- ❌ No concurrency model
- ❌ No PR orchestration

**Opportunity**: Combine both strengths!

---

## Classification Simplification: SIMPLE→MEDIUM→COMPLEX to BASE|COMPLEX

### Original (Too Granular)
- **SIMPLE**: Single file, <30 LOC, low risk → current branch, single PR
- **MEDIUM**: Single module, self-contained, moderate risk → optional worktree, single PR
- **COMPLEX**: Multi-step, cross-cutting, architectural → multi-worktree, sub-PRs

**Problems**:
- LOC heuristics are arbitrary
- "Moderate risk" is subjective
- Three paths to maintain
- Sub-PR orchestration was solving wrong problem

### New (Clean Separation)
- **BASE**: Single-agent implementation on base branch
- **COMPLEX**: Multi-agent parallel implementation in worktrees

**Distinction**: Parallelization capability, not size/risk metrics

**Key principle**: "Can we parallelize without adding overhead?" - user's criterion

---

## The Base Branch Strategy

### Critical Insight: Always Create Base Branch

**BOTH paths start the same way:**

```
dev (main branch)
 │
 └──> feat/my-feature (BASE BRANCH) ← Always created first
       │
       ├─ BASE path: work here directly
       └─ COMPLEX path: create worktrees from here
```

**Why this matters:**
1. Consistent starting point for both paths
2. Base branch becomes "integration point" for COMPLEX
3. Clean separation from dev (single PR at end)
4. Follows semantic prefixing (feat/, fix/, refactor/, chore/)

### The PR Strategy

**One PR only**: base → dev (no sub-PRs)

Original design had sub-PRs (step→base→dev) to "safely review each step." But this added complexity without real benefit:
- Git hooks already enforce quality per commit
- Base branch integration is the real review point
- Sub-PRs create bureaucratic overhead
- Single final PR is cleaner

---

## The Agent Hierarchy Architecture

### The Core Insight: Separation of Concerns

**Main Orchestrator** = workflow guide (never implements)
**Coordinator Agent** = parallelization manager (never implements)
**Implementation Agents** = actual code writers
**Merge Resolver Agent** = conflict specialist

This creates clean delegation where each level has ONE job.

### Full Agent Hierarchy

```
┌─────────────────────────────────────────────────────────────────────┐
│ MAIN ORCHESTRATOR (/claude-orchestration:orc:start)                 │
│                                                                      │
│ Responsibilities:                                                    │
│ • Guide Phases 1-4 (Discovery, Exploration, Questions, Architecture)│
│ • Create base branch from dev (ALWAYS)                              │
│ • Decide BASE vs COMPLEX (after architecture design)                │
│ • Delegate to appropriate execution agent                           │
│ • Final quality review (via reviewer agents)                        │
│ • Create final PR: base → dev                                       │
│ • Summary                                                            │
│                                                                      │
│ Does NOT: Implement code, manage worktrees, handle merges           │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
           BASE PATH               COMPLEX PATH
                │                         │
                ▼                         ▼
    ┌───────────────────────┐   ┌─────────────────────────────────────┐
    │ IMPLEMENTATION AGENT  │   │ COORDINATOR AGENT                   │
    │ (single)              │   │                                     │
    │                       │   │ Responsibilities:                   │
    │ Receives:             │   │ • Receive task breakdown            │
    │ • Task description    │   │ • Break into logical chunks         │
    │ • Base branch name    │   │ • Create worktrees for each chunk   │
    │ • Architecture guide  │   │ • Spawn implementation agents       │
    │                       │   │   (one per worktree, in parallel)   │
    │ Actions:              │   │ • Monitor agent completion          │
    │ • Work on base branch │   │ • Merge worktrees to base           │
    │ • Implement feature   │   │   (sequentially to avoid conflicts) │
    │ • Report completion   │   │ • Spawn merge resolver if conflicts │
    │                       │   │ • Clean up worktrees after merge    │
    │ Returns to:           │   │ • Report completion                 │
    │ Orchestrator          │   │                                     │
    └───────────────────────┘   │ Does NOT: Implement code            │
                                └──────────────┬──────────────────────┘
                                               │
                                  ┌────────────┼────────────┐
                                  │            │            │
                           ┌──────▼──┐  ┌──────▼──┐  ┌─────▼───┐
                           │ IMPL    │  │ IMPL    │  │ IMPL    │
                           │ AGENT A │  │ AGENT B │  │ AGENT C │
                           │         │  │         │  │         │
                           │ Chunk 1 │  │ Chunk 2 │  │ Chunk 3 │
                           │worktree1│  │worktree2│  │worktree3│
                           └─────────┘  └─────────┘  └─────────┘
                                               │
                                  ┌────────────▼──────────────┐
                                  │ All agents completed      │
                                  │ Return to coordinator     │
                                  └────────────┬──────────────┘
                                               │
                                  ┌────────────▼──────────────┐
                                  │ Coordinator merges        │
                                  │ worktrees → base          │
                                  │ (sequentially)            │
                                  └────────────┬──────────────┘
                                               │
                                     ┌─────────▼─────────┐
                                     │ Conflicts?        │
                                     └────┬─────────┬────┘
                                          │ YES     │ NO
                                          │         │
                                   ┌──────▼──┐      │
                                   │ MERGE   │      │
                                   │ RESOLVER│      │
                                   │ AGENT   │      │
                                   │         │      │
                                   │ • Analyze      │
                                   │ • Resolve      │
                                   │ • Return       │
                                   └─────────┘      │
                                          │         │
                                          └────┬────┘
                                               │
                                  ┌────────────▼──────────────┐
                                  │ Base branch integrated    │
                                  │ Worktrees cleaned up      │
                                  │ Return to orchestrator    │
                                  └───────────────────────────┘
```

### Communication Pattern: Subagents Return Final Message

**Important**: Subagents are stateless and isolated:
- They run in separate conversation contexts
- Cannot access parent's TodoWrite
- Cannot be messaged after spawning
- **Communicate ONLY via final return message**

Example:
```
Coordinator spawns Implementation Agent A
  ↓
Agent A works in worktree1
  ↓
Agent A completes implementation
  ↓
Agent A returns final message: "Completed chunk 1: implemented backend API"
  ↓
Coordinator receives message, knows Agent A is done
  ↓
Coordinator proceeds to merge worktree1 → base
```

---

## The Complete Workflow - Full Picture

```
┌───────────────────────────────────────────────────────────────────────┐
│ USER: /claude-orchestration:orc:start <task> [--base <branch>]       │
└─────────────────────────────────┬─────────────────────────────────────┘
                                  │
                     ┌────────────▼────────────┐
                     │ PHASE 1: DISCOVERY      │
                     │ (Anthropic Pattern)     │
                     └────────────┬────────────┘
                                  │
                     ┌────────────▼─────────────────────────────┐
                     │ 1. TodoWrite: Create all phases          │
                     │ 2. Feature clear?                        │
                     │    If NO: Ask clarifying questions       │
                     │    • What problem?                       │
                     │    • What should it do?                  │
                     │    • Constraints?                        │
                     │ 3. Summarize understanding + confirm     │
                     └────────────┬─────────────────────────────┘
                                  │
                     ┌────────────▼────────────────────────────────┐
                     │ PHASE 2: CODEBASE EXPLORATION              │
                     │ (Anthropic Pattern)                        │
                     └────────────┬───────────────────────────────┘
                                  │
                     ┌────────────▼─────────────────────────────────────┐
                     │ 1. Launch 2-3 code-explorer agents (PARALLEL)   │
                     │    Each agent:                                   │
                     │    • Trace through code comprehensively          │
                     │    • Focus on different aspect:                  │
                     │      - Similar features                          │
                     │      - Architecture/abstractions                 │
                     │      - Testing patterns                          │
                     │    • Return list of 5-10 key files              │
                     │                                                  │
                     │ 2. Read all files identified (15-30 total)      │
                     │                                                  │
                     │ 3. Present comprehensive summary                 │
                     └────────────┬─────────────────────────────────────┘
                                  │
                     ┌────────────▼─────────────────────────────────┐
                     │ PHASE 3: CLARIFYING QUESTIONS                │
                     │ (Anthropic Pattern)                          │
                     │ ⚠️  CRITICAL - DO NOT SKIP                   │
                     └────────────┬─────────────────────────────────┘
                                  │
                     ┌────────────▼─────────────────────────────────────┐
                     │ 1. Review codebase findings + request            │
                     │ 2. Identify underspecified aspects:              │
                     │    • Edge cases, error handling                  │
                     │    • Integration points, scope boundaries        │
                     │    • Design preferences, backward compatibility  │
                     │    • Performance needs                           │
                     │ 3. ⏸️  PRESENT questions in organized list       │
                     │ 4. ⏸️  WAIT for user answers                     │
                     └────────────┬─────────────────────────────────────┘
                                  │
                     ┌────────────▼──────────────────────────────────────┐
                     │ PHASE 4: ARCHITECTURE DESIGN                     │
                     │ (Anthropic Pattern)                              │
                     └────────────┬──────────────────────────────────────┘
                                  │
                     ┌────────────▼──────────────────────────────────────────┐
                     │ 1. Launch 2-3 code-architect agents (PARALLEL)       │
                     │    Each proposes different approach:                 │
                     │    • Minimal changes (smallest delta)                │
                     │    • Clean architecture (maintainability)            │
                     │    • Pragmatic balance (speed + quality)             │
                     │                                                      │
                     │ 2. Review all approaches                             │
                     │                                                      │
                     │ 3. Present to user:                                  │
                     │    • Summary of each approach                        │
                     │    • Trade-offs comparison                           │
                     │    • YOUR RECOMMENDATION + reasoning                 │
                     │                                                      │
                     │ 4. ⏸️  ASK user which approach they prefer          │
                     └────────────┬──────────────────────────────────────────┘
                                  │
                     ┌────────────▼─────────────────────────────────────────┐
                     │ PHASE 5: CLASSIFICATION & EXECUTION STRATEGY        │
                     │ (YOUR ADDITION - After understanding architecture)  │
                     └────────────┬─────────────────────────────────────────┘
                                  │
                     ┌────────────▼──────────────────────────────────────────┐
                     │ 1. Create base branch from dev (ALWAYS)              │
                     │    git fetch origin                                   │
                     │    git checkout -b <prefix>/<name> origin/dev        │
                     │    (prefix = feat/fix/refactor/chore)                 │
                     │                                                       │
                     │ 2. Assess architecture for parallelization:          │
                     │    Can we split into independent chunks?              │
                     │    • Different files/modules?                         │
                     │    • No merge conflicts expected?                     │
                     │    • Worth the overhead?                              │
                     │                                                       │
                     │ 3. Classify:                                          │
                     │    BASE: Single-agent implementation                  │
                     │    COMPLEX: Multi-agent parallel implementation       │
                     │                                                       │
                     │ 4. Present strategy to user:                          │
                     │    • Classification decision                          │
                     │    • Rationale                                        │
                     │    • Execution approach                               │
                     │    • For COMPLEX: chunk breakdown                     │
                     │                                                       │
                     │ 5. ⏸️  WAIT for user approval                        │
                     └────────────┬──────────────────────────────────────────┘
                                  │
                     ┌────────────▼────────────┐
                     │ User approves strategy   │
                     └────────────┬────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
               BASE PATH                   COMPLEX PATH
                    │                           │
                    ▼                           ▼
┌─────────────────────────────────┐   ┌──────────────────────────────────────┐
│ PHASE 6a: BASE IMPLEMENTATION   │   │ PHASE 6b: COMPLEX IMPLEMENTATION     │
└─────────────────┬───────────────┘   └──────────────┬───────────────────────┘
                  │                                   │
     ┌────────────▼────────────────┐     ┌───────────▼────────────────────────┐
     │ Spawn implementation agent  │     │ Spawn COORDINATOR AGENT            │
     │                             │     │                                    │
     │ Agent receives:             │     │ Coordinator receives:              │
     │ • Task description          │     │ • Task breakdown                   │
     │ • Base branch name          │     │ • Architecture design              │
     │ • Architecture guidance     │     │ • Base branch name                 │
     │                             │     │ • Chunk definitions                │
     │ Agent works on base branch: │     └───────────┬────────────────────────┘
     │ • Read relevant files       │                 │
     │ • Implement feature         │     ┌───────────▼────────────────────────┐
     │ • Follow conventions        │     │ Coordinator breaks into chunks:    │
     │ • Update TodoWrite          │     │                                    │
     │                             │     │ Chunk 1: Backend API               │
     │ Git hooks enforce quality   │     │ Chunk 2: Frontend UI               │
     │ (automatic, we don't care)  │     │ Chunk 3: Database schema           │
     │                             │     └───────────┬────────────────────────┘
     │ Agent returns completion    │                 │
     └────────────┬────────────────┘     ┌───────────▼────────────────────────┐
                  │                      │ Coordinator creates worktrees:     │
                  │                      │                                    │
                  │                      │ /worktree:create wt1 --base <base> │
                  │                      │ /worktree:create wt2 --base <base> │
                  │                      │ /worktree:create wt3 --base <base> │
                  │                      └───────────┬────────────────────────┘
                  │                                  │
                  │                      ┌───────────▼────────────────────────┐
                  │                      │ Spawn implementation agents        │
                  │                      │ (PARALLEL):                        │
                  │                      │                                    │
                  │                      │ Agent A: Chunk 1 in wt1            │
                  │                      │ Agent B: Chunk 2 in wt2            │
                  │                      │ Agent C: Chunk 3 in wt3            │
                  │                      │                                    │
                  │                      │ Each agent:                        │
                  │                      │ • Works in isolated worktree       │
                  │                      │ • Implements assigned chunk        │
                  │                      │ • Git hooks enforce quality        │
                  │                      │ • Returns completion message       │
                  │                      └───────────┬────────────────────────┘
                  │                                  │
                  │                      ┌───────────▼────────────────────────┐
                  │                      │ Coordinator receives all returns   │
                  │                      │ (blocks until all agents done)     │
                  │                      └───────────┬────────────────────────┘
                  │                                  │
                  │                      ┌───────────▼────────────────────────┐
                  │                      │ Merge worktrees to base            │
                  │                      │ (SEQUENTIALLY):                    │
                  │                      │                                    │
                  │                      │ cd <base-worktree>                 │
                  │                      │ git merge wt1-branch               │
                  │                      │ git merge wt2-branch               │
                  │                      │ git merge wt3-branch               │
                  │                      └───────────┬────────────────────────┘
                  │                                  │
                  │                           ┌──────▼──────┐
                  │                           │ Conflicts?  │
                  │                           └──┬───────┬──┘
                  │                              │ YES   │ NO
                  │                              │       │
                  │                      ┌───────▼──┐    │
                  │                      │ Spawn    │    │
                  │                      │ MERGE    │    │
                  │                      │ RESOLVER │    │
                  │                      │ AGENT    │    │
                  │                      │          │    │
                  │                      │ Receives:│    │
                  │                      │ • Conflict    │
                  │                      │   details     │
                  │                      │ • Both        │
                  │                      │   versions    │
                  │                      │ • Context     │
                  │                      │          │    │
                  │                      │ Resolves:│    │
                  │                      │ • Analyze│    │
                  │                      │ • Decide │    │
                  │                      │ • Fix    │    │
                  │                      │ • Return │    │
                  │                      └──────────┘    │
                  │                              │       │
                  │                              └───┬───┘
                  │                                  │
                  │                      ┌───────────▼────────────────────────┐
                  │                      │ Clean up worktrees:                │
                  │                      │ /worktree:delete wt1               │
                  │                      │ /worktree:delete wt2               │
                  │                      │ /worktree:delete wt3               │
                  │                      └───────────┬────────────────────────┘
                  │                                  │
                  │                      ┌───────────▼────────────────────────┐
                  │                      │ Coordinator returns to orchestrator│
                  │                      │ "Base branch ready with all chunks"│
                  │                      └───────────┬────────────────────────┘
                  │                                  │
                  └──────────────┬───────────────────┘
                                 │
                    ┌────────────▼────────────────────────────────┐
                    │ PHASE 7: QUALITY REVIEW                     │
                    │ (Anthropic Pattern)                         │
                    └────────────┬────────────────────────────────┘
                                 │
                    ┌────────────▼─────────────────────────────────────┐
                    │ Launch 3 code-reviewer agents (PARALLEL):       │
                    │ • Agent 1: Simplicity/DRY/Elegance              │
                    │ • Agent 2: Bugs/Functional correctness          │
                    │ • Agent 3: Project conventions/Abstractions     │
                    │                                                 │
                    │ Consolidate findings                            │
                    │                                                 │
                    │ ⏸️  PRESENT findings to user                    │
                    │ ASK: Fix now / Fix later / Proceed as-is?      │
                    │                                                 │
                    │ Address issues per user direction               │
                    └────────────┬─────────────────────────────────────┘
                                 │
                    ┌────────────▼────────────────────────────────┐
                    │ PHASE 8: FINAL PR & SUMMARY                 │
                    └────────────┬────────────────────────────────┘
                                 │
                    ┌────────────▼─────────────────────────────────────┐
                    │ 1. Create single PR:                            │
                    │    /pr:create --head <base-branch> --base dev   │
                    │                                                 │
                    │ 2. Mark all TodoWrite complete                  │
                    │                                                 │
                    │ 3. Summarize:                                   │
                    │    • What was built                             │
                    │    • Key decisions made                         │
                    │    • Files modified                             │
                    │    • Suggested next steps                       │
                    │                                                 │
                    │ 4. ✅ DONE                                      │
                    └─────────────────────────────────────────────────┘
```

---

## Git Workflow Diagrams

### BASE Path Git Flow

```
origin/dev
    │
    │ git fetch origin
    │ git checkout -b feat/my-feature origin/dev
    │
    ▼
feat/my-feature (base branch)
    │
    │ [Implementation Agent works here]
    │
    ├─ commit: Add user authentication
    ├─ commit: Add password hashing
    ├─ commit: Add login endpoint
    │
    │ [Quality review, fixes]
    │
    ├─ commit: Fix type error in auth service
    │
    │ [Create PR]
    │
    └──> PR: feat/my-feature → dev
         (awaiting review & merge)
```

### COMPLEX Path Git Flow

```
origin/dev
    │
    │ git fetch origin
    │ git checkout -b feat/my-feature origin/dev
    │
    ▼
feat/my-feature (base branch)
    │
    │ [Coordinator creates worktrees]
    │
    ├──> worktree1: feat/my-feature-backend
    │    (from feat/my-feature)
    │    │
    │    │ [Agent A implements backend]
    │    ├─ commit: Add API endpoints
    │    ├─ commit: Add data validation
    │    └─ commit: Add error handling
    │
    ├──> worktree2: feat/my-feature-frontend
    │    (from feat/my-feature)
    │    │
    │    │ [Agent B implements frontend]
    │    ├─ commit: Add login form UI
    │    ├─ commit: Add form validation
    │    └─ commit: Connect to API
    │
    └──> worktree3: feat/my-feature-db
         (from feat/my-feature)
         │
         │ [Agent C implements database]
         ├─ commit: Add users table schema
         ├─ commit: Add migration script
         └─ commit: Add seed data

    [All agents complete]

    [Coordinator merges sequentially]

feat/my-feature (base branch)
    │
    │ git merge feat/my-feature-backend
    ├─ (merge commit or fast-forward)
    │
    │ git merge feat/my-feature-frontend
    ├─ (merge commit or fast-forward)
    │
    │ git merge feat/my-feature-db
    ├─ (merge commit or fast-forward)
    │
    │ [All chunks integrated]
    │ [Worktrees deleted]
    │
    │ [Quality review]
    │
    │ [Create PR]
    │
    └──> PR: feat/my-feature → dev
         (awaiting review & merge)
```

---

## What Gets Removed vs Kept

### 🗑️  REMOVE (Technical Enforcement That Doesn't Work)

**Files to delete:**
- `hooks/planmode.sh` - UserPromptSubmit hook that doesn't enforce workflow
- `hooks/pr-guard.sh` - Wrong hook type, broken field access, solving wrong problem
- `commands/orc/_/run-state` - JSON state management
- `commands/orc/_/approval` - Marker file approach
- `commands/orc/_/locks` - Lock file system (dropping for simplicity)
- All other `commands/orc/_/*` files - will be inlined

**From settings.json:**
- Manual hook registrations for planmode.sh and pr-guard.sh

**State files:**
- `.claude/run/current.json` - custom state tracking
- `.claude/run/$RUN_ID.json` - per-run state
- `.claude/run/orc-plan-approved` - marker files

### ✅ KEEP (Actual Safety + Core Functionality)

**Files to keep:**
- `hooks/worktree-guard.py` - **KEEP** - Blocks Bash tool operations in wrong worktrees (actual safety)
- `/worktree:*` slash commands - Worktree management utilities
- `/pr:create` slash command - PR creation utility
- `/issue:*` slash commands - Issue management utilities

**Why worktree-guard.py is different:**
- It blocks a **TOOL** (Bash), not a workflow
- It prevents actual dangerous operations (running commands in wrong worktree)
- PreToolUse hook with proper tool_name matching
- This IS the correct use of hooks

---

## New File Structure (Proposed)

```
orchestration/
├── .claude-plugin/
│   └── plugin.json                 # Metadata + hook registration
├── commands/
│   ├── orc.md                      # SINGLE self-contained file (inline everything)
│   ├── worktree.md                 # Worktree management utilities (keep as-is)
│   ├── issue.md                    # Issue management utilities (keep as-is)
│   └── pr.md                       # PR creation utilities (keep as-is)
├── agents/
│   ├── coordinator.md              # NEW: Coordinates COMPLEX path
│   ├── implementation.md           # NEW: Implements single chunk
│   ├── merge-resolver.md           # NEW: Resolves merge conflicts
│   ├── code-explorer.md            # Could adapt from Anthropic
│   ├── code-architect.md           # Could adapt from Anthropic
│   └── code-reviewer.md            # Could adapt from Anthropic
├── hooks/
│   └── worktree-guard.py           # KEEP: Blocks Bash in wrong worktrees
└── docs/
    ├── ANALYSIS-anthropic-feature-dev.md
    ├── BRAINSTORM-refactoring-2025-01-12.md  # This file
    └── README.md
```

---

## Key Design Decisions Summary

### 1. Classification After Architecture (Not Before)
- **Why**: More informed decision after understanding codebase and design
- **When**: Phase 5, after architecture agents return their proposals
- **Benefit**: Know if parallelization is actually viable

### 2. BASE|COMPLEX (Not SIMPLE|MEDIUM|COMPLEX)
- **Why**: Clean distinction based on parallelization capability, not arbitrary metrics
- **BASE**: Single-agent implementation
- **COMPLEX**: Multi-agent parallel implementation
- **Benefit**: Simpler mental model, focuses on what matters

### 3. Always Create Base Branch
- **Why**: Consistent starting point, clean separation from dev
- **For BASE**: Work directly on base
- **For COMPLEX**: Create worktrees from base, merge back to base
- **Benefit**: Single PR strategy (base → dev) for both paths

### 4. No Sub-PRs
- **Why**: Git hooks enforce quality per commit, adds bureaucracy without benefit
- **Strategy**: Single final PR (base → dev) after all work complete
- **Benefit**: Cleaner workflow, less overhead

### 5. Sequential Merges (Not Parallel)
- **Why**: Avoid race conditions and complex conflict scenarios
- **How**: Coordinator merges worktrees to base one at a time
- **Benefit**: Simpler conflict detection and resolution

### 6. Specialized Merge Resolver Agent
- **Why**: Conflict resolution is a specialized task
- **When**: Spawned by coordinator if merge conflicts detected
- **Benefit**: Coordinator doesn't need merge expertise, clean delegation

### 7. Git Hooks Handle Quality (Not Workflow)
- **Why**: Pre-commit/pre-push hooks already run lint, type-check, tests
- **Workflow doesn't care**: Let hooks do their job automatically
- **Benefit**: No need to orchestrate quality checks, they just happen

### 8. Natural Language Enforcement (Not Technical Hooks)
- **Why**: Anthropic proves bold text directives work better than hooks
- **Examples**: "⏸️ WAIT for approval", "🛑 DO NOT SKIP"
- **Benefit**: Actually enforces behavior, unlike hooks that get ignored

### 9. TodoWrite Only (Not JSON State)
- **Why**: Built-in, visible, simple
- **Replaces**: `.claude/run/current.json`, per-run state, marker files
- **Benefit**: User sees progress, no hidden state, no file I/O complexity

### 10. Inline All Content (No @ Imports)
- **Why**: @ imports broken in plugins (resolve to project, not plugin)
- **Solution**: Single self-contained orc.md file with all instructions
- **Benefit**: Actually works, easier to maintain

---

## Agent Communication Patterns

### Pattern 1: Parent → Child (Spawning)

```
Orchestrator:
  Task tool → Spawn implementation agent with parameters:
    {
      "task": "Implement user authentication",
      "base_branch": "feat/auth-system",
      "worktree_path": "/path/to/worktree1",
      "architecture_guidance": "Use bcrypt for hashing, JWT for tokens",
      "files_to_read": ["src/lib/auth.ts", "src/db/schema.ts"]
    }
```

### Pattern 2: Child → Parent (Return)

```
Implementation Agent returns final message:
  "✅ Completed: Implemented user authentication in worktree1

  Changes made:
  - Added authentication service (src/lib/auth/service.ts)
  - Added login/register endpoints (src/app/api/auth/)
  - Added user table schema (src/modules/user/db/schema.ts)
  - Added 15 tests (src/lib/auth/service.test.ts)

  All tests passing. Ready for merge to base branch."

Coordinator receives this message and proceeds to merge.
```

### Pattern 3: Coordinator ↔ Multiple Implementation Agents

```
Coordinator spawns 3 agents in parallel:

Task tool (Agent A) → {task: "Backend", worktree: "wt1"}
Task tool (Agent B) → {task: "Frontend", worktree: "wt2"}
Task tool (Agent C) → {task: "Database", worktree: "wt3"}

[Agents work independently]

Agent A returns → Coordinator receives
Agent B returns → Coordinator receives
Agent C returns → Coordinator receives

[All returns collected]

Coordinator proceeds to merge phase.
```

---

## Questions Answered During Brainstorming

### Q1: When should classification happen?
**A**: After architecture design (Phase 5), not upfront. More informed decision.

### Q2: What does "independent parts" mean for COMPLEX?
**A**: Code chunks that can be implemented in parallel without merge conflicts:
- Different files/modules (backend vs frontend)
- Independent features (ComponentA vs ComponentB)
- Different layers (DB schema vs API vs UI)

NOT independent if:
- Editing same files
- Interdependent logic
- Shared state needing coordination

### Q3: Should we keep sub-PR orchestration?
**A**: NO. Single PR (base → dev) after all work complete. Git hooks handle quality per commit.

### Q4: Worktree strategy?
**A**: Always for COMPLEX (if parallelization viable). BASE works directly on base branch.

### Q5: Keep locks for concurrency?
**A**: Drop for simplicity. Worktrees are self-sufficient. Trust orchestrator not to create duplicate worktrees.

### Q6: How do worktrees merge to base?
**A**: Coordinator merges sequentially (one at a time) to avoid race conditions.

### Q7: Quality gates per worktree?
**A**: Forget about it! Git hooks handle this automatically. Workflow doesn't need to care.

### Q8: Delete worktree branches after merge?
**A**: Yes, automatically. Coordinator cleans up after successful merge.

### Q9: Conflict resolution strategy?
**A**: Spawn specialized merge-resolver agent when conflicts detected. Don't make coordinator handle it.

### Q10: Should coordinator oversee COMPLEX path?
**A**: YES! Coordinator agent is key addition. Orchestrator delegates to coordinator, coordinator manages implementation agents.

---

## Next Steps

1. **Write agent definitions:**
   - `agents/coordinator.md` - Manages COMPLEX path
   - `agents/implementation.md` - Implements single chunk
   - `agents/merge-resolver.md` - Resolves conflicts
   - Optionally adapt Anthropic's explorer/architect/reviewer agents

2. **Write new orc.md:**
   - Single self-contained file
   - Inline all classification criteria, flags, constraints
   - Natural language enforcement (bold directives)
   - TodoWrite for state
   - Clear phase progression
   - Proper agent delegation

3. **Update plugin.json:**
   - Remove planmode.sh and pr-guard.sh hook registrations
   - Keep worktree-guard.py registration

4. **Clean up:**
   - Delete `commands/orc/_/*` files
   - Delete `hooks/planmode.sh` and `hooks/pr-guard.sh`
   - Keep `hooks/worktree-guard.py`

5. **Test:**
   - BASE path: Simple feature implementation
   - COMPLEX path: Feature with parallelizable chunks
   - Verify no improvisation (agent follows script)
   - Verify natural language enforcement works
   - Verify coordinator properly manages worktrees

---

## References

- [Anthropic feature-dev plugin](https://github.com/anthropics/claude-code/tree/main/plugins/feature-dev)
- [ANALYSIS-anthropic-feature-dev.md](./ANALYSIS-anthropic-feature-dev.md) - Initial analysis comparing approaches
- [Claude Code plugin docs](https://docs.claude.com/en/docs/claude-code/plugins)
- [Hook reference](https://docs.claude.com/en/docs/claude-code/hooks)

---

**Key Insight**: Orchestrator orchestrates, Coordinator coordinates, Agents implement. Clean separation of concerns wins.
