# META PROMPT: Orchestration Plugin Refactoring

**Purpose**: Refactor the orchestration plugin based on documented architectural decisions. Follow specifications exactly. Do not improvise or deviate from the documented design.

---

## 🎯 MISSION

You are refactoring an existing Claude Code plugin that currently doesn't work due to architectural issues (broken @ imports, ineffective hooks, hidden state management). You must rebuild it following a proven architecture combining Anthropic's feature-dev patterns with custom orchestration logic.

**Critical**: You have a complete specification. Your job is to implement it precisely, not to design, explore, or propose alternatives.

---

## 📚 REQUIRED READING (Read these FIRST, in order)

### 1. Read: `/home/b3ngous/projects/claude-plugins/orchestration/docs/ANALYSIS-anthropic-feature-dev.md`
**Why**: Understand what's broken in current implementation and why

**Key takeaways to internalize:**
- @ imports don't work in plugins (resolve to project, not plugin directory)
- Technical hooks (planmode.sh, pr-guard.sh) don't enforce workflow
- JSON state files add complexity without benefit
- Natural language enforcement (bold text) works reliably
- TodoWrite is superior to custom state management
- Anthropic uses self-contained inline commands (no imports)

### 2. Read: `/home/b3ngous/projects/claude-plugins/orchestration/docs/BRAINSTORM-refactoring-2025-01-12.md`
**Why**: Understand the exact architectural decisions made during brainstorming

**Key takeaways to internalize:**
- BASE|COMPLEX classification (not SIMPLE|MEDIUM|COMPLEX)
- Classification happens AFTER architecture design (Phase 5)
- Always create base branch from dev (for BOTH paths)
- Single PR strategy (base → dev, no sub-PRs)
- Coordinator agent manages COMPLEX path
- Sequential merges (not parallel) to avoid conflicts
- Specialized merge-resolver agent for conflicts
- Git hooks handle quality (workflow doesn't care)
- Agent hierarchy: Orchestrator → Coordinator → Implementation Agents

### 3. Read: Anthropic's feature-dev command (for syntax reference)
**URL**: https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/feature-dev/commands/feature-dev.md

**Study carefully:**
- Phase structure and formatting
- Natural language directives: "**CRITICAL**", "**DO NOT START WITHOUT USER APPROVAL**"
- TodoWrite usage instructions
- Agent spawning patterns
- Approval gate syntax
- How instructions are written (imperative, direct, emphatic)

---

## 📦 DELIVERABLES (Exact files to create/update/delete)

### CREATE (New Files)

#### 1. `/home/b3ngous/projects/claude-plugins/orchestration/commands/orc.md`
**What**: The main orchestration command file
**Requirements**:
- Self-contained (ALL content inline, NO @ imports)
- ~300-500 lines (similar to Anthropic's feature-dev.md)
- Frontmatter with description and argument-hint
- Phases 1-4: Follow Anthropic's pattern exactly
- Phase 5: Classification & strategy (our addition)
- Phase 6a/6b: BASE and COMPLEX execution paths
- Phase 7: Quality review (Anthropic's pattern)
- Phase 8: Final PR & summary
- Natural language enforcement throughout
- TodoWrite for state management
- Clear agent delegation instructions
- Inline classification criteria, constraints, guidelines

#### 2. `/home/b3ngous/projects/claude-plugins/orchestration/agents/coordinator.md`
**What**: Agent that manages COMPLEX path execution
**Requirements**:
- Receives: Task breakdown, architecture design, base branch name, chunk definitions
- Actions: Create worktrees, spawn implementation agents in parallel, monitor completion, merge sequentially, spawn merge-resolver if conflicts, cleanup worktrees
- Returns: Completion message with summary
- Never implements code itself

#### 3. `/home/b3ngous/projects/claude-plugins/orchestration/agents/implementation.md`
**What**: Agent that implements a single chunk
**Requirements**:
- Receives: Chunk description, worktree path (or base branch for BASE path), architecture guidance, files to read
- Actions: Work in assigned location, implement chunk, follow conventions
- Returns: Completion message with changes summary
- For BASE path: works on base branch directly
- For COMPLEX path: works in isolated worktree

#### 4. `/home/b3ngous/projects/claude-plugins/orchestration/agents/merge-resolver.md`
**What**: Specialized agent for resolving merge conflicts
**Requirements**:
- Receives: Conflict details, both versions, context
- Actions: Analyze conflict, resolve intelligently, apply resolution
- Returns: Resolution summary
- One-shot specialist (spawned only when needed)

### UPDATE (Modify Existing Files)

#### 5. `/home/b3ngous/projects/claude-plugins/orchestration/.claude-plugin/plugin.json`
**Changes needed**:
- Remove hook registration for `planmode.sh` (if present)
- Remove hook registration for `pr-guard.sh` (if present)
- **Keep** hook registration for `worktree-guard.py` (this one is correct)
- Ensure commands array includes `orc.md`
- Verify author, description, version metadata

### DELETE (Remove Files)

#### 6. Delete these files/directories:
```
/home/b3ngous/projects/claude-plugins/orchestration/commands/orc/_/
  (entire directory with all contents)
/home/b3ngous/projects/claude-plugins/orchestration/commands/orc/start.md
/home/b3ngous/projects/claude-plugins/orchestration/hooks/planmode.sh
/home/b3ngous/projects/claude-plugins/orchestration/hooks/pr-guard.sh
```

**Keep these**:
```
/home/b3ngous/projects/claude-plugins/orchestration/hooks/worktree-guard.py
  (actual safety hook - blocks Bash in wrong worktrees)
```

---

## 📝 SYNTAX & STYLE GUIDE (Match Anthropic's Patterns)

### Frontmatter Format
```markdown
---
description: Brief description (one line)
argument-hint: <required> [optional] [--flag]
---
```

### Phase Headers
```markdown
## Phase N: Phase Name

**Goal**: What this phase accomplishes

**Actions**:
1. First action
2. Second action
3. Third action
```

### Natural Language Enforcement (Use These Patterns)

**For critical phases:**
```markdown
**CRITICAL**: This is essential. DO NOT SKIP.
```

**For approval gates:**
```markdown
**DO NOT START WITHOUT USER APPROVAL**

**Actions**:
1. Wait for explicit user approval
2. ...
```

**For important waits:**
```markdown
**Present all questions to the user in a clear, organized list**
**Wait for answers before proceeding to architecture design**
```

Use these exact emphatic patterns:
- `**CRITICAL**:`
- `**DO NOT [action]**`
- `**STOP. [instruction]**`
- `⚠️` emoji for warnings
- `⏸️` emoji for pause/wait points
- `🛑` emoji for hard stops

### TodoWrite Instructions
```markdown
## Core Principles

- **Use TodoWrite**: Track all progress throughout

## Phase 1: Discovery

**Actions**:
1. Create todo list with all phases
2. ...
```

### Agent Spawning Syntax
```markdown
**Actions**:
1. Launch 2-3 code-explorer agents in parallel. Each agent should:
   - Focus on different aspect
   - Comprehensive analysis
   - Return list of 5-10 files to read

**Example agent prompts**:
- "Find features similar to [X] and trace implementation comprehensively"
- "Map the architecture and abstractions for [Y] area"
```

---

## 🚫 CRITICAL CONSTRAINTS (What NOT to Do)

### 1. NO @ IMPORTS
```markdown
❌ WRONG:
@./_/classification
@./orc/_/flags

✅ CORRECT:
[Inline the content directly in the file]
```

**Why**: @ imports resolve relative to PROJECT .claude/commands/, not plugin directory. They will always fail in plugins.

### 2. NO JSON STATE MANAGEMENT
```markdown
❌ WRONG:
Write state: echo '{"type":"COMPLEX"}' > .claude/run/current.json

✅ CORRECT:
Use TodoWrite tool for state tracking
```

**Why**: JSON files are hidden, fragile, and add complexity. TodoWrite is visible and built-in.

### 3. NO TECHNICAL ENFORCEMENT HOOKS
```markdown
❌ WRONG:
Hook checks if user ran /orc:start and blocks execution

✅ CORRECT:
**STOP. Wait for user approval before proceeding.**
```

**Why**: Hooks can't enforce natural language workflow. Bold directives work reliably.

### 4. NO BASH STATE MARKERS
```markdown
❌ WRONG:
touch .claude/run/orc-plan-approved
if [[ -f .claude/run/orc-plan-approved ]]; then

✅ CORRECT:
Natural language: "Once approved, proceed to Phase 6"
```

**Why**: Marker files add complexity and are hidden from user.

### 5. NO EXTERNAL FILE REFERENCES
```markdown
❌ WRONG:
Follow `./_/simple-path`.
Read `./_/classification`.

✅ CORRECT:
[Include the instructions inline in the same file]
```

**Why**: References break. Self-contained files work.

### 6. NO SUB-PR ORCHESTRATION
```markdown
❌ WRONG:
Create PR: worktree1 → base
Create PR: worktree2 → base
Create PR: base → dev

✅ CORRECT:
Merge worktree1 → base
Merge worktree2 → base
Create single PR: base → dev
```

**Why**: Git hooks handle quality per commit. Sub-PRs add bureaucracy without benefit.

---

## 📋 CONTENT SPECIFICATIONS (What each file must contain)

### orc.md Structure (Self-Contained Command)

```markdown
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
1. Create todo list with all phases
2. If feature unclear, ask user for:
   - What problem are they solving?
   - What should the feature do?
   - Any constraints or requirements?
3. Summarize understanding and confirm with user

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
4. **Ask user which approach they prefer**

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

### 4. Present Strategy to User

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

**STOP. Wait for user approval before proceeding to implementation.**

---

## Phase 6: Implementation

### Path A: BASE Implementation

**DO NOT START WITHOUT USER APPROVAL**

**Actions**:
1. Wait for explicit user approval
2. Spawn single implementation agent with:
   - Task description
   - Base branch name: `<prefix>/<name>`
   - Architecture guidance from Phase 4
   - Files to read (from Phase 2)
   - Instruction: Work directly on base branch

3. Agent implements feature following chosen architecture
4. Agent returns completion message

**Note**: Git hooks automatically enforce quality (lint, type-check, tests). We don't need to manage this.

---

### Path B: COMPLEX Implementation

**DO NOT START WITHOUT USER APPROVAL**

**Actions**:
1. Wait for explicit user approval
2. Spawn coordinator agent with:
   - Task breakdown (chunks from Phase 5)
   - Architecture guidance from Phase 4
   - Base branch name: `<prefix>/<name>`
   - Files to read (from Phase 2)
   - Instructions for creating worktrees, spawning agents, merging

3. Coordinator agent:
   - Creates worktrees for each chunk
   - Spawns implementation agents in parallel (one per chunk)
   - Monitors completion (via agent return messages)
   - Merges worktrees to base sequentially
   - Spawns merge-resolver agent if conflicts detected
   - Cleans up worktrees after successful merge
   - Returns completion message

**Note**: Git hooks automatically enforce quality per commit. We don't need to manage this.

---

## Phase 7: Quality Review

**Goal**: Ensure code is simple, DRY, elegant, and functionally correct

**Actions**:
1. Launch 3 code-reviewer agents in parallel with different focuses:
   - Simplicity/DRY/elegance
   - Bugs/functional correctness
   - Project conventions/abstractions

2. Consolidate findings and identify highest severity issues
3. **Present findings to user and ask what they want to do**:
   - Fix now
   - Fix later
   - Proceed as-is

4. Address issues per user direction

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
Subagents (implementation agents, coordinator, merge-resolver) are stateless:
- Cannot access parent's TodoWrite
- Cannot be messaged after spawning
- Communicate ONLY via final return message
- Parent receives return message and proceeds

### Concurrency Model
No locks needed. Worktrees provide isolation. Trust orchestration not to create duplicate worktrees.

---
```

**Total length**: ~400-500 lines when complete

---

### coordinator.md Structure

```markdown
---
description: Coordinates COMPLEX path execution with parallel agents
subagent-type: general-purpose
---

# Coordinator Agent

You are coordinating the COMPLEX execution path for a feature. Your job is to break the feature into independent chunks, create worktrees, spawn implementation agents in parallel, monitor their completion, merge their work sequentially to the base branch, and clean up.

**You do not implement code yourself.** You delegate to implementation agents.

---

## Context You Will Receive

- **Task breakdown**: The feature broken into logical chunks (from Phase 5)
- **Architecture guidance**: Chosen approach from Phase 4
- **Base branch name**: The branch created in Phase 5 (e.g., `feat/user-auth`)
- **Files to read**: Key files from Phase 2 exploration

---

## Your Responsibilities

### 1. Create Worktrees

For each chunk, create an isolated worktree:

```bash
/worktree:create <worktree-name> --base <base-branch>
```

Example:
```bash
/worktree:create wt-backend --base feat/user-auth
/worktree:create wt-frontend --base feat/user-auth
/worktree:create wt-database --base feat/user-auth
```

Each worktree gets its own branch from base.

---

### 2. Spawn Implementation Agents (Parallel)

For each chunk, spawn an implementation agent using the Task tool:

```
Task tool:
  subagent_type: general-purpose
  prompt: "You are implementing [chunk description].

  **Context**:
  - Worktree path: /path/to/worktree
  - Branch: <branch-name>
  - Base branch: <base-branch>
  - Architecture guidance: [from Phase 4]
  - Files to read first: [list from Phase 2]

  **Your task**:
  Implement [detailed chunk description]. Follow the architecture guidance strictly. Work in the worktree specified above.

  **When complete**:
  Return a message with:
  - Summary of changes made
  - Files created/modified
  - Any important notes

  DO NOT merge your work. The coordinator will handle merging."
```

Launch all agents in parallel (multiple Task tool calls in same message).

---

### 3. Monitor Completion

Wait for all implementation agents to return. Each will send a final message with their completion summary.

You'll know all agents are done when you've received return messages from all of them.

---

### 4. Merge Worktrees to Base (Sequential)

**Important**: Merge sequentially (one at a time) to avoid race conditions.

For each worktree:

```bash
# Switch to base branch worktree
cd /path/to/base-worktree

# Merge the chunk branch
git merge <chunk-branch>
```

Example:
```bash
git merge wt-backend-branch
git merge wt-frontend-branch
git merge wt-database-branch
```

If merge succeeds, continue to next worktree.

---

### 5. Handle Conflicts (If Any)

If a merge produces conflicts:

```bash
# Check for conflicts
git status
```

If conflicts exist, spawn merge-resolver agent:

```
Task tool:
  subagent_type: general-purpose
  prompt: "You are resolving a merge conflict.

  **Context**:
  - Base branch: <base-branch>
  - Merging: <chunk-branch>
  - Conflict files: [list files with conflicts]

  **Conflict details**:
  [Show conflict markers from git status]

  **Your task**:
  1. Analyze both versions
  2. Resolve conflicts intelligently
  3. Stage resolved files: git add <files>
  4. Complete merge: git commit

  **When complete**:
  Return summary of how conflicts were resolved."
```

Wait for merge-resolver to return, then continue to next worktree.

---

### 6. Clean Up Worktrees

After all merges complete successfully:

```bash
/worktree:delete <worktree-name>
```

Example:
```bash
/worktree:delete wt-backend
/worktree:delete wt-frontend
/worktree:delete wt-database
```

---

### 7. Return to Orchestrator

Send final message:

```
✅ COMPLEX implementation complete

**Chunks implemented**:
1. Backend API - [summary]
2. Frontend UI - [summary]
3. Database schema - [summary]

**All changes merged to base branch**: <base-branch>

**Worktrees cleaned up**: All temporary worktrees deleted

**Base branch ready** for quality review and PR creation.
```

---

## Important Notes

- **You never implement code** - you delegate to implementation agents
- **Merge sequentially** - one worktree at a time, not parallel
- **Spawn merge-resolver if conflicts** - don't try to resolve yourself
- **Clean up after success** - delete worktrees once merged
- **Git hooks handle quality** - you don't need to run lint/test/type-check

---
```

---

### implementation.md Structure

```markdown
---
description: Implements a single chunk or full feature
subagent-type: general-purpose
---

# Implementation Agent

You are implementing code for a feature or chunk. You will receive detailed instructions about what to build, where to work, and what architecture to follow.

---

## Context You Will Receive

For **BASE path** (single feature):
- Task description (full feature)
- Base branch name (e.g., `feat/user-auth`)
- Work directly on base branch

For **COMPLEX path** (single chunk):
- Chunk description (one part of feature)
- Worktree path
- Branch name
- Base branch name

Both receive:
- Architecture guidance (from Phase 4)
- Files to read (from Phase 2)
- Project conventions

---

## Your Responsibilities

### 1. Understand Context

Read all files mentioned in your instructions. Understand:
- Existing patterns in the codebase
- Architecture you must follow
- Conventions and style

---

### 2. Implement Your Task

**For BASE path**:
```bash
# You're on the base branch
git branch --show-current  # Should show: feat/...

# Implement feature
# Create files, edit files, follow architecture
```

**For COMPLEX path**:
```bash
# You're in a worktree with its own branch
cd /path/to/worktree
git branch --show-current  # Should show: wt-...-branch

# Implement your chunk only
# Stay within your chunk's scope
```

---

### 3. Follow Best Practices

- Follow the architecture guidance strictly
- Match existing code conventions
- Write clean, documented code
- Create tests if appropriate (follow project patterns)
- Make focused commits with clear messages

**Git hooks will automatically check**:
- Linting
- Type checking
- Tests
- Validation

If hooks fail, fix the issues and commit again.

---

### 4. Return Completion Summary

When your implementation is complete, return a message:

```
✅ Implementation complete: [Chunk/Feature name]

**Changes made**:
- Created: [list new files]
- Modified: [list changed files]
- Tests: [if added tests, describe them]

**Summary**:
[2-3 sentences describing what was implemented]

**Important notes**:
[Any notes about decisions, trade-offs, or things to be aware of]

**Ready for**: [Merge (COMPLEX) / Quality Review (BASE)]
```

---

## Important Notes

- **DO NOT merge your work** (COMPLEX path) - coordinator handles merging
- **DO NOT create PRs** - orchestrator handles PR creation
- **Git hooks enforce quality** - you don't need to run commands manually
- **Stay in your scope** - implement what you're assigned, no more
- **Follow architecture strictly** - don't deviate from chosen approach

---
```

---

### merge-resolver.md Structure

```markdown
---
description: Resolves merge conflicts during COMPLEX path integration
subagent-type: general-purpose
---

# Merge Resolver Agent

You are a specialized agent for resolving merge conflicts. You will be spawned by the coordinator agent when merging worktrees to the base branch produces conflicts.

---

## Context You Will Receive

- **Base branch**: The branch receiving merges (e.g., `feat/user-auth`)
- **Merging branch**: The branch being merged (e.g., `wt-backend-branch`)
- **Conflict files**: List of files with conflicts
- **Conflict details**: Content showing conflict markers

---

## Your Responsibilities

### 1. Analyze the Conflict

Examine both versions:
- What changes were made in base branch?
- What changes were made in merging branch?
- Why do they conflict?

```bash
# View conflict details
git status
git diff --conflict

# Read the files with conflict markers
# Look for <<<<<<< ======= >>>>>>> markers
```

---

### 2. Resolve Intelligently

Make informed decisions:
- Are both changes needed? (combine them)
- Is one change correct? (choose it)
- Do changes need adjustment? (modify to integrate both)

Resolve by editing files to remove conflict markers and integrate changes properly.

---

### 3. Stage and Commit

```bash
# After resolving conflicts in files
git add <resolved-files>

# Complete the merge
git commit
```

The commit message will be auto-generated by git (merge commit message).

---

### 4. Return Resolution Summary

```
✅ Merge conflicts resolved

**Files resolved**:
- [list files that had conflicts]

**Resolution approach**:
[Describe how you resolved conflicts - which changes were kept, combined, or modified]

**Merge complete**: Changes from [merging-branch] successfully integrated into [base-branch]
```

---

## Important Notes

- **One-shot specialist**: You're spawned for one conflict resolution, then done
- **Understand both sides**: Don't blindly choose one version
- **Test if possible**: If you can verify the resolution works, do so
- **Clear explanation**: Coordinator needs to understand what you did

---
```

---

## ✅ VALIDATION STEPS (How to Verify It Works)

After implementing all deliverables, perform these validation checks:

### 1. File Structure Check
```bash
# Verify new structure
ls -la /home/b3ngous/projects/claude-plugins/orchestration/commands/
# Should show: orc.md (not orc/ directory)

ls -la /home/b3ngous/projects/claude-plugins/orchestration/agents/
# Should show: coordinator.md, implementation.md, merge-resolver.md

ls -la /home/b3ngous/projects/claude-plugins/orchestration/hooks/
# Should show: worktree-guard.py (NOT planmode.sh or pr-guard.sh)
```

### 2. Content Validation

**orc.md**:
- [ ] Frontmatter with description and argument-hint present
- [ ] Phases 1-8 all present and properly structured
- [ ] No @ imports anywhere in file
- [ ] No references to external files
- [ ] Natural language directives present (CRITICAL, DO NOT START, etc.)
- [ ] TodoWrite mentioned in Core Principles and Phase 1
- [ ] Agent spawning instructions in Phases 2, 4, 6, 7
- [ ] BASE and COMPLEX paths both present in Phase 6
- [ ] Classification criteria inlined in Phase 5
- [ ] No JSON state management instructions
- [ ] No marker file instructions
- [ ] Single PR strategy (Phase 8)
- [ ] Base branch always created (Phase 5)

**Agent files (coordinator.md, implementation.md, merge-resolver.md)**:
- [ ] Each has frontmatter with description and subagent-type
- [ ] Clear responsibility definitions
- [ ] Instructions for what they receive
- [ ] Instructions for what they do
- [ ] Instructions for what they return
- [ ] No improvisation - specific step-by-step

**plugin.json**:
- [ ] No planmode.sh hook registration
- [ ] No pr-guard.sh hook registration
- [ ] worktree-guard.py hook IS registered
- [ ] commands array includes orc.md

### 3. Syntax Validation

Open each .md file and verify:
- [ ] Uses `**Text**` for bold (not `__Text__`)
- [ ] Uses proper markdown headers (`##`, not `###` for phases)
- [ ] Code blocks use triple backticks with language hints
- [ ] Frontmatter uses correct YAML syntax
- [ ] No trailing @ symbols or references

### 4. Consistency Check

- [ ] Terminology consistent across files (BASE/COMPLEX, not SIMPLE/MEDIUM/COMPLEX)
- [ ] Base branch creation mentioned consistently
- [ ] TodoWrite mentioned (not JSON state)
- [ ] Agent names match between files (coordinator, implementation, merge-resolver)

---

## ✨ ACCEPTANCE CRITERIA (Definition of Done)

### Critical Requirements (Must Have)

- [ ] **orc.md is self-contained**: No @ imports, all content inline
- [ ] **Natural language enforcement**: Bold directives present at key points
- [ ] **TodoWrite for state**: No JSON files, no marker files
- [ ] **Correct classification**: BASE|COMPLEX (not SIMPLE|MEDIUM|COMPLEX)
- [ ] **Base branch always created**: In Phase 5, for both paths
- [ ] **Single PR strategy**: base → dev, no sub-PRs
- [ ] **Agent hierarchy present**: Orchestrator → Coordinator → Implementation
- [ ] **Sequential merges**: COMPLEX path merges worktrees one at a time
- [ ] **Git hooks mentioned**: "Git hooks handle quality automatically"
- [ ] **Merge resolver exists**: Specialized agent for conflict resolution
- [ ] **Files deleted**: commands/orc/_, hooks/planmode.sh, hooks/pr-guard.sh
- [ ] **worktree-guard.py kept**: Only safety hook remaining

### Quality Requirements (Should Have)

- [ ] **Matches Anthropic's style**: Phase structure, directive syntax similar
- [ ] **Clear instructions**: Each step is specific and actionable
- [ ] **No ambiguity**: Agent knows exactly what to do
- [ ] **Proper length**: ~400-500 lines for orc.md (not too short, not too long)
- [ ] **Agent definitions clear**: Responsibilities, inputs, outputs specified
- [ ] **Examples provided**: Agent prompts shown where helpful

### Validation Requirements (Must Pass)

- [ ] **No improvisation possible**: All instructions explicit
- [ ] **Can't use @ imports**: None present anywhere
- [ ] **Can't create JSON state**: No instructions to do so
- [ ] **Can't use hooks for workflow**: Natural language used instead
- [ ] **Follows brainstorm spec**: Matches documented architecture

---

## 🎬 EXECUTION PLAN (Step-by-Step)

Follow this order precisely:

### Step 1: Read and Internalize
1. Read ANALYSIS-anthropic-feature-dev.md completely
2. Read BRAINSTORM-refactoring-2025-01-12.md completely
3. Read Anthropic's feature-dev.md for syntax reference
4. Confirm you understand: "I've read all three documents and understand the architecture"

### Step 2: Create Agent Files (Least Dependent First)
1. Create `agents/merge-resolver.md` (independent specialist)
2. Create `agents/implementation.md` (called by coordinator)
3. Create `agents/coordinator.md` (calls implementation + merge-resolver)

### Step 3: Create Main Command
1. Create `commands/orc.md` (references agents from Step 2)
2. Verify it's self-contained (no @ imports)
3. Verify all phases present (1-8)
4. Verify natural language enforcement throughout

### Step 4: Update Plugin Manifest
1. Read current `plugin.json`
2. Remove planmode.sh hook (if present)
3. Remove pr-guard.sh hook (if present)
4. Verify worktree-guard.py hook is still registered
5. Verify commands array includes "orc.md"

### Step 5: Delete Old Files
1. Delete `commands/orc/start.md`
2. Delete `commands/orc/_/` directory (entire directory)
3. Delete `hooks/planmode.sh`
4. Delete `hooks/pr-guard.sh`
5. Verify `hooks/worktree-guard.py` is NOT deleted

### Step 6: Validation
1. Run all validation checks from "VALIDATION STEPS" section
2. Check all items in "ACCEPTANCE CRITERIA" section
3. Read through orc.md as if you're Claude receiving the command
4. Verify no ambiguity, no room for improvisation

### Step 7: Summary
1. List all files created
2. List all files updated
3. List all files deleted
4. Confirm all acceptance criteria met
5. Note any issues or concerns (should be none)

---

## ⚠️ COMMON MISTAKES TO AVOID

### Mistake 1: Using @ imports
```markdown
❌ @./_/classification
❌ @./orc/_/flags
❌ Follow `./_/simple-path`.

✅ [Inline the content directly - see Phase 5 for classification criteria]
```

### Mistake 2: Adding JSON state management
```markdown
❌ echo '{"type":"COMPLEX"}' > .claude/run/current.json
❌ RUN_ID=$(date +%Y-%m-%d-%H%M%S)
❌ Write to .claude/run/$RUN_ID.json

✅ Use TodoWrite tool for tracking progress
```

### Mistake 3: Creating sub-PR instructions
```markdown
❌ Create PR: worktree1 → base
❌ Create PR: worktree2 → base
❌ Create final PR: base → dev

✅ Merge worktrees to base, then single PR: base → dev
```

### Mistake 4: Using technical hooks for workflow
```markdown
❌ "The planmode hook will enforce planning phase"
❌ "The pr-guard hook will block incorrect PRs"

✅ "**STOP. Wait for user approval before proceeding.**"
```

### Mistake 5: Wrong classification terminology
```markdown
❌ SIMPLE/MEDIUM/COMPLEX
❌ Classification: Based on LOC or file count

✅ BASE/COMPLEX
✅ Classification: Based on parallelization capability
```

### Mistake 6: Parallel merges
```markdown
❌ Merge all worktrees simultaneously
❌ Use parallel bash commands to merge

✅ Merge worktrees sequentially (one at a time)
```

### Mistake 7: Forgetting base branch creation
```markdown
❌ BASE path works on current branch
❌ Create base branch only for COMPLEX

✅ ALWAYS create base branch in Phase 5 (for both BASE and COMPLEX)
```

### Mistake 8: Making coordinator implement code
```markdown
❌ Coordinator implements chunks itself
❌ Coordinator merges and also codes

✅ Coordinator only coordinates - spawns agents to implement
```

---

## 📊 EXPECTED FILE SIZES (Rough Estimates)

- `commands/orc.md`: ~400-500 lines
- `agents/coordinator.md`: ~150-200 lines
- `agents/implementation.md`: ~100-150 lines
- `agents/merge-resolver.md`: ~80-100 lines
- `.claude-plugin/plugin.json`: ~50-80 lines (minor edits only)

If your files are significantly shorter, you're probably missing content. If significantly longer, you might be over-explaining.

---

## 🎯 SUCCESS METRICS

You've succeeded when:

1. **No improvisation possible**: Agent following orc.md can't make up stuff - everything is specified
2. **Self-contained**: orc.md works without any external file dependencies
3. **Follows brainstorm**: Architecture matches BRAINSTORM-refactoring-2025-01-12.md exactly
4. **Matches Anthropic style**: Natural language enforcement, phase structure similar
5. **Clean separation**: Orchestrator → Coordinator → Implementation hierarchy clear
6. **Validation passes**: All checks in "VALIDATION STEPS" pass
7. **Acceptance criteria met**: All items in "ACCEPTANCE CRITERIA" checked

---

## ❓ IF YOU'RE UNSURE

If you encounter ambiguity or uncertainty:

1. **Check the brainstorm doc**: Answer is probably documented there
2. **Check Anthropic's example**: See how they handle it
3. **Follow the constraint**: When in doubt, follow the "Critical Constraints" section
4. **Ask**: Better to ask for clarification than to deviate from spec

**Do NOT improvise or add features not in the brainstorm.**

---

## 🚀 READY TO BEGIN?

Confirm your understanding by stating:

1. "I have read all three required documents"
2. "I understand this is a refactoring to a documented specification"
3. "I will not improvise or deviate from the brainstorm architecture"
4. "I will use natural language enforcement, not technical hooks"
5. "I will create self-contained files with no @ imports"
6. "I will use TodoWrite for state, not JSON files"

Then begin with Step 1 of the Execution Plan.

**Good luck! Follow the spec precisely.**
