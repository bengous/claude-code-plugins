# Orchestration Commands

Reference for task orchestration and multi-agent coordination.

## Overview

Orchestration commands provide guided 8-phase workflow with automatic BASE/COMPLEX classification, TodoWrite tracking, and structured execution paths.

## Command List

1. [/orc](#orc) - Alias to /orc:start
2. [/orc:start](#orcstart) - Execute guided 8-phase orchestration

---

## /orc

**Description:** Alias for `/orc:start`. Main entry point for orchestration.

**Usage:**
```bash
/orc "<task_description>" [options]
```

See [/orc:start](#orcstart) for full documentation.

---

## /orc:start

**Description:** Execute task using guided 8-phase workflow with BASE/COMPLEX routing.

**Usage:**
```bash
/orc:start "<task_description>" [options]
```

**Arguments:**
- `<task_description>` (required) - Natural language task description

**Options:**
- `--base <branch>` - Base branch for divergence (default: `dev`)

**Core Principles:**
- ✅ **TodoWrite tracking** throughout all phases
- ✅ **Clarifying questions** before implementation
- ✅ **Deep codebase exploration** with parallel agents
- ✅ **Always create base branch** for both BASE and COMPLEX paths

---

## The 8-Phase Workflow

### Phase 1: Discovery

**Goal:** Understand what needs to be built

**Actions:**
1. **CRITICAL FIRST STEP: Create TodoWrite** with all 8 phases
2. If feature unclear, ask clarifying questions
3. Summarize understanding

**Checkpoint:** None (context setting)

---

### Phase 2: Codebase Exploration

**Goal:** Understand relevant existing code and patterns

**Actions:**
1. Launch 2-3 code-explorer agents in parallel:
   - Find similar features
   - Map architecture and abstractions
   - Analyze testing patterns
2. Read all files identified by agents
3. Present comprehensive summary

**Checkpoint:** None (information gathering)

---

### Phase 3: Clarifying Questions

**Goal:** Fill in gaps and resolve all ambiguities

**CRITICAL:** This is one of the most important phases. DO NOT SKIP.

**Actions:**
1. Review codebase findings and original request
2. Identify underspecified aspects:
   - Edge cases and error handling
   - Integration points and scope boundaries
   - Design preferences and backward compatibility
   - Performance needs
3. **Present all questions in clear, organized list**
4. **✋ CHECKPOINT: WAIT FOR USER ANSWERS** (ESSENTIAL)

---

### Phase 4: Architecture Design

**Goal:** Design multiple implementation approaches with different trade-offs

**Actions:**
1. Launch 2-3 code-architect agents in parallel:
   - Minimal changes (smallest change, maximum reuse)
   - Clean architecture (maintainability, elegant abstractions)
   - Pragmatic balance (speed + quality)
2. Review all approaches and form opinion
3. Present to user:
   - Brief summary of each approach
   - Trade-offs comparison
   - **Your recommendation with reasoning**
4. **💬 ADAPTIVE CHECKPOINT:** User can say "sounds good" to proceed or discuss alternatives

---

### Phase 5: Classification & Execution Strategy

**Goal:** Determine execution path and create base branch

**Actions:**

#### 1. Create Base Branch (ALWAYS, for both paths)

Determine branch prefix:
- `feat/` for new features
- `fix/` for bug fixes
- `refactor/` for refactoring
- `chore/` for maintenance

Create from dev:
```bash
git fetch origin
git checkout -b <prefix><descriptive-name> origin/dev
```

Example: `feat/user-authentication`, `fix/login-validation`

#### 2. Assess Parallelization Potential

Analyze:
- Can we split into independent chunks?
- Different files/modules? (backend vs frontend)
- No merge conflicts expected?
- Worth the overhead?

#### 3. Classify Execution Path

**BASE** (Single-Agent Implementation):
- Feature can be implemented as cohesive unit
- No clear parallelization benefit
- Single agent works directly on base branch
- Straightforward, single-threaded execution

**COMPLEX** (Multi-Agent Parallel Implementation):
- Feature can be split into independent chunks
- Chunks can be worked on in parallel without conflicts
- Worth the overhead of coordination
- Each chunk gets isolated worktree + dedicated agent

#### 4. Present Strategy & Get Approval

Present:
- **Classification:** BASE or COMPLEX
- **Rationale:** Why this classification (2-3 bullets)
- **Base branch created:** `<prefix>/<name>`
- **Execution approach:**
  - BASE: Single agent, direct implementation
  - COMPLEX: Break into N chunks, parallel agents, sequential merge
- **For COMPLEX:** Show chunk breakdown

**✋ CHECKPOINT: APPROVE EXECUTION? (yes/no)** (ESSENTIAL)
- Yes → Phase 6 begins immediately
- No → Revise strategy or abort

---

### Phase 6: Implementation

Two execution paths based on classification:

---

#### Path A: BASE Implementation

**Begins immediately after Phase 5 approval**

**CRITICAL:** Orchestrator MUST delegate to subagent. Never implements directly.

**Actions:**
1. **Spawn single implementation agent** with:
   - Task description
   - Base branch name
   - Architecture guidance from Phase 4
   - Files to read from Phase 2
   - Instruction: Create internal TodoWrite and work on base branch
2. Agent implements feature following chosen architecture
3. Agent returns completion message

**Checkpoint:** None (flows to Phase 7)

**Example:**
```bash
/orc "Add email validation to login form"

# → Classifies as BASE (single concern, ~50 LOC)
# → Creates branch: feat/email-validation
# → Spawns implementation agent
# → Agent works on base branch
# → Agent commits and returns summary
# → Flows to Phase 7 Quality Review
```

---

#### Path B: COMPLEX Implementation

**Begins immediately after Phase 5 approval**

**Three Sequential Steps:**

##### Step 1: Planning

1. Spawn planning coordinator agent with:
   - Task breakdown (chunks from Phase 5)
   - Architecture guidance (from Phase 4)
   - Base branch name
   - Files to read (from Phase 2)

   Agent will:
   - Create worktrees using /worktree:create
   - Get worktree paths/branches using /worktree:open
   - Analyze file dependencies
   - Return YAML execution plan

2. Wait for planning coordinator to return with plan

**Checkpoint:** None (flows to Step 2)

##### Step 2: Implementation (PARALLEL)

3. Review the execution plan from planning coordinator
4. Create TodoWrite to track execution
5. **Spawn implementation agents in PARALLEL** (one per chunk):
   - Pass: Chunk description, worktree path, branch name, architecture guidance
   - Agent implements in isolated worktree
   - Agent returns completion summary
   - **Launch all agents in same message for parallel execution**

6. Wait for all implementation agents to return

7. Review each agent's return message:
   - **⚠️ CONDITIONAL CHECKPOINT:** If any blocking errors → STOP, inform user
   - If all succeeded → proceed to Step 3

8. Update TodoWrite to mark chunks complete

##### Step 3: Merging (SEQUENTIAL)

9. Spawn merge coordinator agent with:
   - Execution plan (YAML from planning coordinator)
   - Implementation summaries (from all agents)
   - Base branch name

   Agent will:
   - Verify all implementations succeeded
   - Merge worktrees sequentially (following plan's merge_order)
   - Resolve conflicts inline if they occur
   - Clean up worktrees
   - Return completion summary

10. Wait for merge coordinator to return
11. Update TodoWrite to mark merge step complete

**Checkpoint:** None unless errors (flows to Phase 7)

**Example:**
```bash
/orc "Refactor authentication system to support OAuth"

# → Classifies as COMPLEX (3 modules: core, OAuth, UI)
# → Creates branch: refactor/oauth-auth
# → Planning coordinator creates 3 worktrees
# → 3 implementation agents work in parallel:
#    - Agent A: Core auth module (worktree-auth-core)
#    - Agent B: OAuth integration (worktree-auth-oauth)
#    - Agent C: UI updates (worktree-auth-ui)
# → All agents return success
# → Merge coordinator merges sequentially to refactor/oauth-auth
# → Flows to Phase 7 Quality Review
```

---

### Phase 7: Quality Review

**Goal:** Ensure code is simple, DRY, elegant, and functionally correct

**CRITICAL: ALWAYS run this phase**, even for simple BASE tasks.

**Why mandatory:**
- Git hooks catch syntax/type errors, but miss design issues
- Reviewers find redundancy, complexity, and subtle bugs
- Quality review prevents issues that slip through automated checks
- Small tasks get fast review (~2 min), large tasks get thorough review

**Adaptive Approach:**

**For BASE path:**
Launch 1-2 code-reviewer agents:
- Focus 1: Simplicity/DRY/elegance
- Focus 2: Bugs/functional correctness

**For COMPLEX path:**
Launch 3 code-reviewer agents in parallel:
- Focus 1: Simplicity/DRY/elegance
- Focus 2: Bugs/functional correctness
- Focus 3: Cross-chunk integration and conventions

**Actions:**
1. Launch appropriate number of code-reviewer agents in parallel
2. Consolidate findings and categorize by severity:
   - **HIGH:** Bugs, broken functionality, critical issues
   - **MEDIUM:** Design improvements, significant tech debt
   - **LOW:** Style issues, minor improvements

3. **⚠️ CONDITIONAL CHECKPOINT:**
   - **HIGH severity found** → STOP: Present findings and ask what to do (fix now / fix later / proceed as-is)
   - **MEDIUM/LOW only** → Report findings but proceed automatically

4. Address issues per user direction

---

### Phase 8: Final PR & Summary

**Goal:** Create pull request and document what was accomplished

**Actions:**

#### 1. Create Pull Request

Create single PR from base branch to dev:
```bash
/pr:create --head <prefix>/<name> --base dev --title "..." --body "..."
```

Example:
```bash
/pr:create --head feat/user-authentication --base dev
```

**Important:** Single PR strategy. No sub-PRs.

#### 2. Summary

Mark all TodoWrite items complete.

Summarize:
- **What was built:** Brief description of the feature
- **Classification:** BASE or COMPLEX
- **Key decisions made:** Architecture choices, trade-offs
- **Files modified:** List of changed files
- **Suggested next steps:** What could be done next

#### 3. Done

Feature complete and ready for review!

**Checkpoint:** None (completion)

---

## Key Features

### TodoWrite Tracking

**Enforced at Phase 1:** Orchestrator MUST create TodoWrite list with all 8 phases before proceeding.

Example:
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

Provides:
- Progress visibility
- Prevents phase skipping
- Enables checkpoint tracking
- User can see what's happening

### Subagent Delegation

**BASE path:** Orchestrator spawns 1 implementation agent
**COMPLEX path:** Orchestrator spawns planning coordinator, N implementation agents, merge coordinator

**All agents:**
- Use internal TodoWrite for tracking their work
- Are stateless (cannot access parent's TodoWrite)
- Communicate only via final return message
- Main orchestrator spawns ALL agents (flat model, no hierarchy)

### Git Hooks Handle Quality

Pre-commit and pre-push hooks automatically run:
- Linting (biome, eslint, etc.)
- Type checking (tsc)
- Tests (vitest, playwright)
- Custom validation

If hooks fail, commit/push is blocked. The workflow doesn't need to orchestrate quality gates - they're enforced by git hooks.

### Worktree Isolation (COMPLEX Path Only)

The `worktree-guard.py` hook ensures agents don't run commands in wrong worktrees. This is a **safety mechanism** (blocks dangerous operations), not workflow enforcement.

---

## Examples

### Example 1: Simple Bug Fix (BASE)

```bash
/orc "Fix typo in user profile form validation message"

# Phase 1: Discovery
# • Creates TodoWrite
# • Summarizes: Fix typo in validation message

# Phase 2: Codebase Exploration
# • Spawns 2 explorers to find validation code
# • Identifies: src/components/UserProfile/validation.ts

# Phase 3: Clarifying Questions
# • Which typo? "Email adress" → "Email address"
# ✋ User confirms

# Phase 4: Architecture Design
# • Spawns 2 architects (minimal vs thorough)
# • Recommends: Direct string replacement
# 💬 User: "sounds good"

# Phase 5: Classification & Strategy
# • Creates branch: fix/profile-validation-typo
# • Classifies as BASE (single string, 1 line)
# ✋ User approves execution

# Phase 6: Implementation (BASE)
# • Spawns implementation agent
# • Agent fixes typo and commits
# • Returns completion

# Phase 7: Quality Review
# • Spawns 2 reviewers (simplicity + bugs)
# • No issues found
# • Proceeds automatically

# Phase 8: Final PR & Summary
# • Creates PR: fix/profile-validation-typo → dev
# • Marks all todos complete
# • Done!
```

---

### Example 2: New Feature Module (COMPLEX)

```bash
/orc "Add real-time notification system with WebSocket support"

# Phase 1: Discovery
# • Creates TodoWrite
# • Summarizes: Real-time notifications via WebSocket

# Phase 2: Codebase Exploration
# • Spawns 3 explorers (WebSocket patterns, notification patterns, testing)
# • Identifies: Existing event system, user preferences, frontend state management

# Phase 3: Clarifying Questions
# • Browser notification support? Yes
# • Persistence layer? Redis for active connections
# • Reconnection strategy? Exponential backoff
# ✋ User answers all questions

# Phase 4: Architecture Design
# • Spawns 3 architects (minimal, clean, pragmatic)
# • Recommends: Pragmatic (WebSocket server + client lib + UI components)
# • Trade-offs: Balance between reuse and clean separation
# 💬 User: "Let's go with pragmatic"

# Phase 5: Classification & Strategy
# • Creates branch: feat/realtime-notifications
# • Analyzes: 3 independent chunks (backend, client, UI)
# • Classifies as COMPLEX (parallelizable)
# • Shows chunk breakdown:
#   - Chunk 1: Backend WebSocket server
#   - Chunk 2: Client-side notification library
#   - Chunk 3: UI notification components
# ✋ User approves execution

# Phase 6: Implementation (COMPLEX)
# • Step 1: Planning coordinator creates 3 worktrees, returns YAML plan
# • Step 2: Spawns 3 implementation agents in PARALLEL
#   - Agent A: Implements WebSocket server (worktree-backend)
#   - Agent B: Implements client library (worktree-client)
#   - Agent C: Implements UI components (worktree-ui)
# • All agents return success
# • Step 3: Merge coordinator merges sequentially (backend → client → UI)
# • All merged to feat/realtime-notifications

# Phase 7: Quality Review
# • Spawns 3 reviewers (simplicity + bugs + integration)
# • Findings:
#   - MEDIUM: Client reconnection logic could be simpler
#   - LOW: Add JSDoc comments
# • No HIGH severity
# • Reports findings but proceeds

# Phase 8: Final PR & Summary
# • Creates PR: feat/realtime-notifications → dev
# • Marks all todos complete
# • Summary includes:
#   - Backend: WebSocket server with Redis
#   - Client: Notification library with reconnection
#   - UI: Toast components with preferences
# • Done!
```

---

## Checkpoint Summary

### Essential Checkpoints (Always Stop)
1. **Phase 3:** Clarifying questions - need information to proceed
2. **Phase 5:** Execution approval - last gate before costly work

### Adaptive Checkpoint (Can Skip)
3. **Phase 4:** Architecture choice - user can say "sounds good"

### Conditional Checkpoints (Only If Issues)
4. **Phase 6B:** Implementation errors - only if agents fail
5. **Phase 7:** Quality review - only if HIGH severity bugs found

**Typical flow:** 2-3 stops (down from historical 7-stop workflows)

---

## Troubleshooting

### TodoWrite Not Created

If orchestrator skips TodoWrite in Phase 1:
- This is a bug - the workflow specification requires it
- Stop and create manually, then request orchestrator proceed
- Report issue so specification can be strengthened

### Orchestrator Implements Instead of Delegating

If orchestrator implements code directly in Phase 6 BASE:
- This violates the delegation principle
- Stop execution and remind: "You are an orchestrator, not an implementer"
- Request spawning implementation agent

### Quality Review Skipped

If orchestrator skips Phase 7:
- This violates the workflow specification (Phase 7 is mandatory)
- Git hooks still run, so code quality maintained
- But design issues may be missed
- Request quality review be executed

### Agent Doesn't Use Internal TodoWrite

If subagent doesn't create internal TodoWrite:
- Not strictly required but recommended
- Subagents may complete work successfully without it
- Consider it a best practice, not a hard requirement

---

## Best Practices

1. **Trust the Checkpoints**
   - Essential checkpoints (Phase 3, 5) are there for good reason
   - Adaptive checkpoint (Phase 4) can be skipped if you trust the recommendation
   - Conditional checkpoints only appear when needed

2. **Be Specific in Discovery**
   - Detailed initial description → fewer clarifying questions
   - Vague description → more back-and-forth in Phase 3

3. **Engage in Architecture Design**
   - Review trade-offs carefully
   - "Sounds good" is fine if recommendation makes sense
   - Discuss alternatives if uncertain

4. **Let BASE/COMPLEX Classification Guide You**
   - BASE: Fast, focused, single-agent execution
   - COMPLEX: Parallel work, thorough coordination
   - Trust the orchestrator's assessment

5. **Review Quality Findings**
   - HIGH severity: Always address before merge
   - MEDIUM/LOW: Can address in follow-up PR
   - Phase 7 prevents technical debt accumulation

---

**Related:**
- [Workflow Overview Diagram](../workflow-overview.md)
- [PR Commands](pr.md)
- [Worktree Management](worktree.md)
