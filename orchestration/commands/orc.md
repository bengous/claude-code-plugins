---
description: Guided orchestration with classification and isolation
argument-hint: <task> [--base <branch>]
---

# Orchestration Workflow

## Core Principles

- **Use TodoWrite**: Track all progress throughout
- **Ask clarifying questions**: Identify ambiguities before implementing
- **Understand before acting**: Deep codebase exploration first
- **Always create base branch**: For BASE and COMPLEX paths

---

## Phase 1: Discovery

**Goal**: Understand what needs to be built

Initial request: $ARGUMENTS

**Actions**:

**CRITICAL FIRST STEP: Create TodoWrite Immediately**

Before doing ANYTHING else, create a TodoWrite list tracking all phases:

TodoWrite format:
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

Mark the current phase as in_progress, others as pending. Update status throughout workflow.

**Why critical:**
- Provides visibility to user
- Prevents phase skipping
- Enables checkpoint tracking
- Required for proper orchestration

DO NOT proceed without creating this TodoWrite first.

---

**Then continue:**
1. If feature unclear, ask user for:
   - What problem are they solving?
   - What should the feature do?
   - Any constraints or requirements?
2. Summarize understanding (clarification happens in Phase 3 if needed)

---

## Phase 2: Codebase Exploration

**Goal**: Understand relevant existing code and patterns

**Actions**:
1. Launch 2-3 code-explorer agents in parallel. Each agent should:
   - Trace through the code comprehensively
   - Target a different aspect of the codebase
   - Include a list of 5-10 key files to read

   **Example agent prompts**:
   - "Find features similar to [feature] and trace through implementation comprehensively"
   - "Map the architecture and abstractions for [feature area]"
   - "Analyze testing patterns and conventions for [area]"

2. Once agents return, read all files identified by agents
3. Present comprehensive summary of findings

---

## Phase 3: Clarifying Questions

**Goal**: Fill in gaps and resolve all ambiguities

**CRITICAL**: This is one of the most important phases. DO NOT SKIP.

**Actions**:
1. Review the codebase findings and original feature request
2. Identify underspecified aspects:
   - Edge cases and error handling
   - Integration points and scope boundaries
   - Design preferences and backward compatibility
   - Performance needs
3. **Present all questions to the user in a clear, organized list**
4. **Wait for answers before proceeding to architecture design**

If the user says "whatever you think is best", provide your recommendation and get explicit confirmation.

---

## Phase 4: Architecture Design

**Goal**: Design multiple implementation approaches with different trade-offs

**Actions**:
1. Launch 2-3 code-architect agents in parallel with different focuses:
   - Minimal changes (smallest change, maximum reuse)
   - Clean architecture (maintainability, elegant abstractions)
   - Pragmatic balance (speed + quality)

2. Review all approaches and form your opinion on which fits best
3. Present to user:
   - Brief summary of each approach
   - Trade-offs comparison
   - **Your recommendation with reasoning**
   - Concrete implementation differences
4. **Recommendation**: Present your choice with clear rationale
   - User can say "sounds good" / "go ahead" / "pick best" to proceed with recommendation
   - Or user can specify which approach they prefer and discuss trade-offs
5. If user approves/defers: proceed with recommendation
   If user engages with alternatives: discuss and finalize choice

---

## Phase 5: Classification & Execution Strategy

**Goal**: Determine execution path and create base branch

**Actions**:

### 1. Create Base Branch (ALWAYS, for both paths)

Determine branch prefix based on task type:
- `feat/` for new features
- `fix/` for bug fixes
- `refactor/` for refactoring
- `chore/` for maintenance

Create base branch from dev:
```bash
git fetch origin
git checkout -b <prefix><descriptive-name> origin/dev
```

Example: `feat/user-authentication`, `fix/login-validation`

### 2. Assess Parallelization Potential

Based on architecture design, analyze:
- Can we split into independent chunks?
  - Different files/modules? (backend vs frontend)
  - No merge conflicts expected?
  - Independent features? (ComponentA vs ComponentB)
- Is parallelization worth the overhead?
- Clear boundaries between chunks?

### 3. Classify Execution Path

**Classification Criteria:**

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
- Coordinator manages parallel execution + merging

### 4. Present Strategy & Get Approval

Present:
- **Classification**: BASE or COMPLEX
- **Rationale**: Why this classification (2-3 bullets)
- **Base branch created**: `<prefix>/<name>`
- **Execution approach**:
  - BASE: Single agent, direct implementation
  - COMPLEX: Break into N chunks, parallel agents, sequential merge
- **For COMPLEX**: Show chunk breakdown:
  ```
  Chunk 1: Backend API (files: ...)
  Chunk 2: Frontend UI (files: ...)
  Chunk 3: Database schema (files: ...)
  ```

**Approve execution? (yes/no)**
- Yes → Phase 6 (Implementation) begins immediately
- No → Revise strategy or abort

---

## Phase 6: Implementation

### Path A: BASE Implementation

(Begins immediately after Phase 5 approval)

**CRITICAL: YOU ARE AN ORCHESTRATOR, NOT AN IMPLEMENTER**

Even for simple tasks, you MUST delegate to a subagent using the Task tool. NEVER implement code yourself.

**Why?**
- Clear separation: Coordinator vs Worker
- Consistent delegation model across BASE and COMPLEX
- Subagent can use internal TodoWrite for tracking
- Maintains workflow integrity and patterns

**Actions**:
1. **Spawn single implementation agent** using Task tool:

   Example prompt format:
   ```
   You are implementing [feature description] on branch [base-branch-name].

   **Context:**
   - Architecture approach: [summary from Phase 4]
   - Base branch: [branch name]
   - Working directory: Current directory is on the base branch

   **Files to read first:**
   [List key files from Phase 2 exploration]

   **Your task:**
   1. Create internal TodoWrite to track your work
   2. Read the files above to understand patterns
   3. Implement the feature following the architecture
   4. Make commits as you go (git hooks will enforce quality)
   5. Return completion summary

   **Remember:** You're stateless - include all info in your final message.
   ```

2. **Wait for agent to return** with completion message
3. Review agent's summary and proceed to Phase 7

**DO NOT implement anything yourself.** Your role is orchestration only.

**Note**: Git hooks automatically enforce quality (lint, type-check, tests). We don't need to manage this.

---

### Path B: COMPLEX Implementation

(Begins immediately after Phase 5 approval)

**Actions**:

### Step 1: Planning

1. Spawn planning coordinator agent with:
   - Task breakdown (chunks from Phase 5)
   - Architecture guidance (from Phase 4)
   - Base branch name: `<prefix>/<name>`
   - Files to read (from Phase 2)

   Agent will:
   - Create worktrees using /worktree:create
   - Get worktree paths/branches using /worktree:open
   - Analyze file dependencies
   - Return YAML execution plan

   See agents/planning-coordinator.md for full specifications.

2. Wait for planning coordinator to return with execution plan

---

### Step 2: Implementation

3. Review the execution plan returned by planning coordinator

4. Create TodoWrite to track execution:
   ```
   - ✓ Execution plan created
   - ⏳ Implement [chunk 1 name]
   - ⏳ Implement [chunk 2 name]
   - ⏳ Implement [chunk 3 name]
   - ⏳ Merge all chunks to base
   - ⏳ Quality review
   ```

5. Spawn implementation agents in parallel (one per chunk):

   For each chunk in the execution plan:
   - Pass: Chunk description, worktree path, branch name, architecture guidance, files to read
   - Agent implements in isolated worktree
   - Agent returns completion summary

   **Launch all agents in same message for parallel execution.**

   See agents/implementation.md for full specifications.

6. Wait for all implementation agents to return

7. Review each agent's return message:
   - If any agent reports blocking errors → STOP, inform user
   - If all agents completed successfully → proceed to merging

8. Update TodoWrite to mark implementation chunks complete

---

### Step 3: Merging

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

    See agents/merge-coordinator.md for full specifications.

10. Wait for merge coordinator to return

11. Update TodoWrite to mark merge step complete

**Note**: Git hooks automatically enforce quality per commit. We don't need to manage this.

---

## Phase 7: Quality Review

**Goal**: Ensure code is simple, DRY, elegant, and functionally correct

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
(Omit conventions reviewer since single implementation maintains consistency)

**For COMPLEX path:**
Launch 3 code-reviewer agents in parallel:
- Focus 1: Simplicity/DRY/elegance
- Focus 2: Bugs/functional correctness
- Focus 3: Cross-chunk integration and conventions

**Actions**:
1. Launch appropriate number of code-reviewer agents in parallel (1-2 for BASE, 3 for COMPLEX)

2. Consolidate findings and categorize by severity:
   - **HIGH**: Bugs, broken functionality, critical issues
   - **MEDIUM**: Design improvements, significant tech debt
   - **LOW**: Style issues, minor improvements

3. **If HIGH severity issues found**:
   **STOP**: Present findings to user and ask what to do:
   - Fix now
   - Fix later (document as known issues)
   - Proceed as-is (user accepts risk)

4. **If only MEDIUM/LOW severity issues**:
   Report findings but proceed automatically (or offer quick "auto-fix" option)

5. Address issues per user direction (if HIGH found and user wants fixes)

**DO NOT skip this phase** - quality review is a core part of orchestration.

---

## Phase 8: Final PR & Summary

**Goal**: Create pull request and document what was accomplished

**Actions**:

### 1. Create Pull Request

Create single PR from base branch to dev:
```bash
/pr:create --head <prefix>/<name> --base dev --title "..." --body "..."
```

Example:
```
/pr:create --head feat/user-authentication --base dev
```

**Important**: Single PR strategy. No sub-PRs.

### 2. Summary

Mark all TodoWrite items complete.

Summarize:
- **What was built**: Brief description of the feature
- **Classification**: BASE or COMPLEX
- **Key decisions made**: Architecture choices, trade-offs
- **Files modified**: List of changed files
- **Suggested next steps**: What could be done next

### 3. Done

Feature complete and ready for review!

---

## Important Notes

### Git Hooks Handle Quality
Pre-commit and pre-push hooks automatically run:
- Linting (biome, eslint, etc.)
- Type checking (tsc)
- Tests (vitest, playwright)
- Custom validation

**You don't need to run these manually.** They happen automatically on commit/push. If they fail, the commit/push is blocked. The workflow doesn't need to orchestrate quality gates - they're enforced by git hooks.

### Worktree Isolation (COMPLEX Path Only)
The `worktree-guard.py` hook ensures agents don't run commands in wrong worktrees. This is a **safety mechanism** (blocks dangerous operations), not workflow enforcement.

### State Management
Use TodoWrite exclusively for tracking progress. No JSON files, no marker files, no custom state.

### Agent Communication
Subagents (planning coordinator, implementation agents, merge coordinator) are stateless:
- Cannot access parent's TodoWrite
- Cannot be messaged after spawning
- Communicate ONLY via final return message
- Parent receives return message and proceeds

### Concurrency Model
No locks needed. Worktrees provide isolation. Trust orchestration not to create duplicate worktrees.

---
