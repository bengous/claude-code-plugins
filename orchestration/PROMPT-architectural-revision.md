# Prompt: Architectural Revision - Planning Coordinator Model

## ⚠️ CRITICAL: Current Phase 6b Is WRONG

**The current orc.md Phase 6b (lines 184-206) still uses the OLD hierarchical architecture that we identified as broken.**

**What's wrong**:
```markdown
2. Spawn coordinator agent with:
   ...
3. Coordinator agent:
   - Spawns implementation agents in parallel  ← ASSUMES hierarchical spawning (uncertain!)
   - Monitors completion
   - Merges worktrees
```

This assumes a coordinator agent can spawn other agents (hierarchical spawning), which may not be possible.

**Your task**: REPLACE the current Phase 6b entirely with the new flat spawning model described below.

---

## The Problem

**Context**: After applying the high-priority fixes, we identified a critical architectural assumption that may be incorrect: **Can subagents spawn other subagents?**

The current COMPLEX path design assumes the Coordinator Agent can spawn Implementation Agents. If this capability doesn't exist, the COMPLEX path is fundamentally broken.

**Solution**: Redesign the architecture so the Main Orchestrator spawns all agents directly, using a **Planning Coordinator** to create the execution plan.

---

### Current Architecture (Potentially Broken):
```
Main Orchestrator (orc.md)
    └─> spawns Coordinator Agent
           └─> spawns Implementation Agent A  ← May not be possible!
           └─> spawns Implementation Agent B  ← May not be possible!
           └─> spawns Implementation Agent C  ← May not be possible!
```

**Risk**: If subagents cannot spawn other subagents (via Task tool), the COMPLEX path fails completely.

### New Architecture (Guaranteed to Work):
```
Main Orchestrator (orc.md)
    ├─> spawns Planning Coordinator Agent (creates plan + worktrees)
    ├─> Orchestrator reads plan, creates TodoWrite
    ├─> spawns Implementation Agent A (backend)
    ├─> spawns Implementation Agent B (frontend)
    ├─> spawns Implementation Agent C (database)
    └─> spawns Merge Coordinator Agent (merges A+B+C to base)
```

**Benefit**:
- Main Orchestrator spawns ALL agents (guaranteed to work)
- Planning Coordinator only plans (no Task tool usage)
- Clear separation: Planning → Execution → Merging

---

## Agent Responsibilities (Revised)

### **Planning Coordinator Agent** (new role)
**What it does**:
- Creates worktrees for each chunk using `/worktree:create`
- Uses `/worktree:open` to get worktree paths and branches
- Analyzes which files each chunk will modify (avoid conflicts)
- Returns detailed execution plan in YAML format

**What it does NOT do**:
- ❌ Spawn implementation agents (orchestrator does this)
- ❌ Implement code
- ❌ Merge worktrees
- ❌ Monitor agent progress

**Returns**: Structured YAML execution plan with worktree details, file mappings, merge order

---

### **Main Orchestrator** (expanded role)
**What it does**:
- Spawns planning coordinator agent
- Reads and acknowledges execution plan
- **Creates TodoWrite** from plan (visible to user)
- **Spawns all implementation agents** in parallel
- Waits for agent completions
- Updates TodoWrite as agents complete
- Spawns merge coordinator agent
- Receives merge completion, proceeds to Phase 7

**What it does NOT do**:
- ❌ Create worktrees directly (planning coordinator does this)
- ❌ Merge worktrees (merge coordinator does this)

---

### **Implementation Agents** (unchanged)
**What they do**:
- Implement assigned chunk in isolated worktree
- Return completion summary

**What they do NOT do**:
- ❌ Merge their work (merge coordinator does this)
- ❌ Create PRs (orchestrator does this)

---

### **Merge Coordinator Agent** (new agent)
**What it does**:
- Receives execution plan from orchestrator
- Merges worktrees to base branch **sequentially** (one at a time)
- Resolves conflicts inline (analyzes both versions, edits files, commits)
- Cleans up worktrees after successful merges
- Returns completion summary

**What it does NOT do**:
- ❌ Create worktrees (planning coordinator already did)
- ❌ Spawn agents (fully flat architecture - no sub-subagents)
- ❌ Implement code

---

## Files to Create/Modify/Rename

### 1. **Rename and Rewrite**: coordinator.md → planning-coordinator.md

**Current file**: `/home/b3ngous/projects/claude-plugins/orchestration/agents/coordinator.md`
**New file**: `/home/b3ngous/projects/claude-plugins/orchestration/agents/planning-coordinator.md`

**Action**: Create NEW file with content below (don't modify existing coordinator.md yet)

**Content for planning-coordinator.md**:

```markdown
---
description: Creates execution plan and worktrees for COMPLEX path
subagent-type: general-purpose
---

# Planning Coordinator Agent

You are planning the parallel implementation of a complex feature. Your job is to create worktrees for each chunk, analyze file dependencies, and return a detailed execution plan for the orchestrator to follow.

**You do not implement code yourself.** You do not spawn agents. You only plan.

---

## Important: You Are Stateless

You are running in an isolated agent context, separate from the parent orchestrator.

**What this means**:
- You **cannot access** the parent orchestrator's TodoWrite or conversation state
- You **cannot send messages** to the orchestrator after being spawned
- You **must include all information** in your final return message
- You receive **all context upfront** in your spawning prompt (task breakdown, architecture guidance, base branch name)
- Once you return your final message, your context is destroyed - no follow-up questions possible

**Therefore**:
- Create the complete execution plan in one pass
- Include all worktree details (paths, branches, files)
- Make autonomous decisions about chunk organization
- Don't assume you can provide additional information later

---

## Context You Will Receive

- **Task breakdown**: The feature broken into logical chunks (from Phase 5)
- **Architecture guidance**: Chosen approach from Phase 4
- **Base branch name**: The branch created in Phase 5 (e.g., `feat/user-auth`)
- **Files to read**: Key files from Phase 2 exploration

---

## Your Responsibilities

### 1. Create Worktrees for Each Chunk

For each chunk in the task breakdown, create an isolated worktree:

```bash
/worktree:create <worktree-name> --base <base-branch>
```

**Naming convention**: `wt-<chunk-identifier>`

Example:
```bash
/worktree:create wt-backend --base feat/user-auth
/worktree:create wt-frontend --base feat/user-auth
/worktree:create wt-database --base feat/user-auth
```

---

### 2. Retrieve Worktree Information

After creating each worktree, get its path and branch:

```bash
/worktree:open <worktree-name>
```

This returns:
- Worktree absolute path: `/path/to/worktree/<worktree-name>`
- Branch name: `<worktree-name>-branch`

Example:
```bash
/worktree:open wt-backend
# Returns: /home/user/project/.worktrees/wt-backend, branch: wt-backend-branch
```

Store this information for each worktree to include in your execution plan.

---

### 3. Analyze File Dependencies

Based on architecture guidance and codebase exploration, identify:
- Which files each chunk will modify
- Potential conflict areas (same files modified by multiple chunks)
- Dependencies between chunks (if any)

**Goal**: Provide clear boundaries so implementation agents don't conflict.

---

### 4. Determine Merge Order

Decide the order in which worktrees should be merged to base branch:
- Consider dependencies (chunk A's output needed by chunk B)
- Consider conflict probability (merge likely-conflicting chunks first for easier resolution)
- Default: Order doesn't matter if truly independent

---

### 5. Return Execution Plan

Return a structured YAML execution plan:

```yaml
# Execution Plan for [Feature Name]

base_branch: feat/user-auth

chunks:
  - name: Backend API
    worktree: wt-backend
    path: /home/user/project/.worktrees/wt-backend
    branch: wt-backend-branch
    description: Implement authentication endpoints and middleware
    files_to_modify:
      - src/modules/auth/server/actions.ts
      - src/modules/auth/server/services/auth-service.ts
      - src/modules/auth/server/index.ts
    estimated_scope: ~150 lines

  - name: Frontend UI
    worktree: wt-frontend
    path: /home/user/project/.worktrees/wt-frontend
    branch: wt-frontend-branch
    description: Create login/register forms and authentication UI
    files_to_modify:
      - src/modules/auth/ui/LoginForm.tsx
      - src/modules/auth/ui/RegisterForm.tsx
      - src/modules/auth/ui/AuthProvider.tsx
    estimated_scope: ~200 lines

  - name: Database Schema
    worktree: wt-database
    path: /home/user/project/.worktrees/wt-database
    branch: wt-database-branch
    description: Add users table and authentication-related schema
    files_to_modify:
      - src/modules/auth/db/schema.ts
      - src/db/index.ts
    estimated_scope: ~80 lines

merge_order:
  - wt-database    # Merge first (foundation)
  - wt-backend     # Merge second (uses database schema)
  - wt-frontend    # Merge last (uses backend API)

conflict_warnings:
  - "wt-backend and wt-database both modify src/db/index.ts - potential conflict"

architecture_notes:
  - "All chunks follow module structure: {server,ui,core,types,db}"
  - "Server actions require 'use server' directive"
  - "Database schema uses Drizzle ORM conventions"
```

**Format requirements**:
- Valid YAML syntax
- Include all fields shown above
- Be specific about file paths
- Provide clear descriptions
- Note any warnings or dependencies

---

## Important Notes

- **You create worktrees** - The orchestrator will NOT create them
- **You do NOT spawn agents** - The orchestrator will spawn implementation agents
- **You do NOT implement code** - Implementation agents will do this
- **You do NOT merge worktrees** - Merge coordinator agent will do this
- **Return complete plan** - Orchestrator relies on your plan to execute
- **Be autonomous** - Make decisions based on provided context

---
```

---

### 2. **Create New File**: merge-coordinator.md

**New file**: `/home/b3ngous/projects/claude-plugins/orchestration/agents/merge-coordinator.md`

**Content**:

```markdown
---
description: Merges worktrees to base branch sequentially for COMPLEX path
subagent-type: general-purpose
---

# Merge Coordinator Agent

You are merging parallel implementations back to the base branch. Your job is to merge worktrees sequentially, resolve any conflicts inline, clean up worktrees, and return a completion summary.

**You do not implement code yourself.** You only merge existing work.

---

## Important: You Are Stateless

You are running in an isolated agent context, separate from the parent orchestrator.

**What this means**:
- You **cannot access** the parent orchestrator's TodoWrite or conversation state
- You **cannot send messages** to the orchestrator after being spawned
- You **must include all information** in your final return message
- You receive **all context upfront** (execution plan, agent summaries, base branch)
- Once you return your final message, your context is destroyed - no follow-up possible

**Therefore**:
- Complete all merges in one execution
- Handle conflicts autonomously (resolve them inline)
- Include complete summary in return message
- Clean up all worktrees before returning

---

## Context You Will Receive

- **Execution plan**: The YAML plan from planning coordinator (includes merge order, worktree paths, branches)
- **Implementation summaries**: Return messages from all implementation agents (what they built)
- **Base branch name**: The branch to merge into (e.g., `feat/user-auth`)

---

## Your Responsibilities

### 1. Verify All Implementations Completed

Review the implementation agent summaries you received.

**If any agent reported errors**:
- Do NOT proceed with merging
- Return error report immediately:

```
MERGE ABORTED

**Reason**: Implementation agent reported blocking errors

**Failed chunk**: [chunk name]
**Error details**: [copy agent's error message]

**Successful chunks**: [list any that completed]
**Worktrees NOT merged**: All worktrees still exist for debugging

**Recommendation**: Fix the blocking error and retry COMPLEX implementation
```

**If all agents completed successfully**:
- Proceed to merging

---

### 2. Merge Worktrees to Base (Sequential)

**CRITICAL**: Merge sequentially (one at a time), following the merge order from the execution plan.

**Why sequential**: Avoids race conditions and makes conflict resolution predictable.

For each worktree in merge order:

```bash
# Switch to base branch
git checkout <base-branch>

# Merge the worktree branch
git merge <worktree-branch>
```

Example following execution plan:
```bash
# Merge wt-database first
git checkout feat/user-auth
git merge wt-database-branch

# Merge wt-backend second
git merge wt-backend-branch

# Merge wt-frontend third
git merge wt-frontend-branch
```

**After each merge**:
- Check if merge succeeded
- If conflicts → proceed to step 3
- If success → continue to next worktree

---

### 3. Handle Conflicts (If Any)

If a merge produces conflicts:

```bash
# Check for conflicts
git status
```

**Resolve conflicts inline:**

1. **Identify conflicted files**: Files with `<<<<<<< HEAD` markers

2. **Read each conflicted file** to understand both versions:
   - `<<<<<<< HEAD` = Current base branch version
   - `=======` = Separator
   - `>>>>>>> <branch-name>` = Incoming worktree branch version

3. **Analyze the conflict**:
   - What does each version do?
   - Are they conflicting changes or complementary?
   - Which version should take precedence?
   - Can both be kept (e.g., merging imports, combining logic)?

4. **Resolve by editing the file**:
   - Remove conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
   - Keep the correct version or combine both intelligently
   - Ensure the result is syntactically valid

5. **Stage resolved files**:
```bash
git add <resolved-file-1> <resolved-file-2> ...
```

6. **Complete the merge**:
```bash
git commit -m "Merge <worktree-branch>: resolved conflicts in <files>"
```

7. **Document the resolution** in your return message (which files, what approach)

Then continue to next worktree in merge order.

---

### 4. Clean Up Worktrees

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

**Verify cleanup**: All temporary worktrees should be deleted.

---

### 5. Return to Orchestrator

Send final completion message:

```
COMPLEX implementation merged successfully

**Chunks merged** (in order):
1. Database Schema (wt-database) - Merged cleanly
   - Files: src/modules/auth/db/schema.ts, src/db/index.ts
   - Changes: Added users table with authentication fields

2. Backend API (wt-backend) - Conflicts resolved
   - Files: src/modules/auth/server/actions.ts, server/services/auth-service.ts
   - Changes: Implemented login/register endpoints
   - Conflicts: src/db/index.ts (resolved by keeping both imports)

3. Frontend UI (wt-frontend) - Merged cleanly
   - Files: src/modules/auth/ui/LoginForm.tsx, ui/RegisterForm.tsx
   - Changes: Created authentication UI components

**Base branch status**: feat/user-auth
**All changes integrated**: Yes
**Worktrees cleaned up**: wt-database, wt-backend, wt-frontend deleted

**Next step**: Ready for Phase 7 (Quality Review)
```

---

## Important Notes

- **Merge sequentially** - One worktree at a time, not parallel
- **Follow merge order** - From execution plan (dependencies matter)
- **Resolve conflicts inline** - Analyze both versions and combine intelligently
- **Clean up after success** - Delete all worktrees before returning
- **Include details** - Orchestrator needs to know what was merged and how
- **Git hooks handle quality** - Don't run lint/test/type-check manually

---
```

---

### 3. **CRITICAL FIX**: Replace orc.md Phase 6b (COMPLEX Implementation)

**File**: `/home/b3ngous/projects/claude-plugins/orchestration/commands/orc.md`

**Current status**: Lines 184-206 contain INCORRECT hierarchical architecture

**What to do**:
- **DELETE** the entire current "### Path B: COMPLEX Implementation" section (lines 184-206)
- **REPLACE** with the new flat spawning model below

**Find and delete**:
```markdown
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
```

**Replace with**:

```markdown
### Path B: COMPLEX Implementation

**DO NOT START WITHOUT USER APPROVAL**

**Actions**:

### Step 1: Planning

1. Wait for explicit user approval

2. Spawn planning coordinator agent with:
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

3. Wait for planning coordinator to return with execution plan

---

### Step 2: Implementation

4. Review the execution plan returned by planning coordinator

5. Create TodoWrite to track execution:
   ```
   - ✓ Execution plan created
   - ⏳ Implement [chunk 1 name]
   - ⏳ Implement [chunk 2 name]
   - ⏳ Implement [chunk 3 name]
   - ⏳ Merge all chunks to base
   - ⏳ Quality review
   ```

6. Spawn implementation agents in parallel (one per chunk):

   For each chunk in the execution plan:
   - Pass: Chunk description, worktree path, branch name, architecture guidance, files to read
   - Agent implements in isolated worktree
   - Agent returns completion summary

   **Launch all agents in same message for parallel execution.**

   See agents/implementation.md for full specifications.

7. Wait for all implementation agents to return

8. Review each agent's return message:
   - If any agent reports blocking errors → STOP, inform user
   - If all agents completed successfully → proceed to merging

9. Update TodoWrite to mark implementation chunks complete

---

### Step 3: Merging

10. Spawn merge coordinator agent with:
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

11. Wait for merge coordinator to return

12. Update TodoWrite to mark merge step complete

**Note**: Git hooks automatically enforce quality per commit. We don't need to manage this.

---
```

---

## Summary of Changes

### ⚠️ **This is a FIX, not an enhancement**

The current Phase 6b in orc.md is WRONG - it uses hierarchical agent spawning that may not work. This revision fixes the architecture.

### Files to Create:
1. **agents/planning-coordinator.md** (~180 lines) - Plans execution, creates worktrees, returns YAML plan
2. **agents/merge-coordinator.md** (~210 lines) - Merges worktrees sequentially, resolves conflicts inline, cleans up

### Files to Modify:
3. **commands/orc.md** - **DELETE and REPLACE** Phase 6b (lines 184-206)
   - **Current**: 22 lines with BROKEN hierarchical architecture
   - **New**: 60 lines with CORRECT flat spawning model
   - **Impact**: +38 lines to orc.md (294 → 332 lines total)
   - **Approach**: Reference-based (not full example prompts)
   - Details live in agent files, orc.md stays concise

### Files to Delete (After Testing):
4. **agents/coordinator.md** - Replaced by planning-coordinator.md (keep for now as backup)

---

## Design Philosophy: Reference-Based Approach

**Why orc.md stays concise:**

The new Phase 6b uses a **reference-based approach** instead of full example prompts:
- ✅ **What to do**: Spawn agent X
- ✅ **What to pass**: Bullet list of context
- ✅ **Where to look**: "See agents/X.md for full specifications"
- ❌ **Not full example prompts**: Too verbose, hard to maintain

**Why this works:**
- Agent files contain comprehensive "Context You Will Receive" sections
- Orchestrator knows WHAT to pass (listed in orc.md)
- Agents know WHAT to expect (detailed in agent files)
- Details live where they belong (agent files, not orc.md)
- Changes to agent specs don't require orc.md edits

**Result**: orc.md stays at ~332 lines (reasonable) instead of ~402 lines (bloated)

---

## Execution Order

1. **Create planning-coordinator.md** - New file with planning role (~180 lines)
2. **Create merge-coordinator.md** - New file with merging role (~160 lines)
3. **Update orc.md Phase 6b** - Replace COMPLEX implementation section with reference-based version (~60 lines)
4. **Test the flow** - Try a simple COMPLEX task to verify architecture
5. **Delete old coordinator.md** - Once new architecture is verified

---

## Key Architectural Changes

| Aspect | Old Design | New Design |
|--------|-----------|------------|
| **Agent spawning** | Coordinator spawns agents | Orchestrator spawns all agents |
| **Coordinator role** | Executor (spawn+merge) | Planner (plan+worktrees) |
| **Control flow** | Hierarchical (nested) | Flat (orchestrator controls) |
| **TodoWrite** | Hidden in coordinator | Visible in orchestrator |
| **Merge logic** | In coordinator | In separate merge coordinator |
| **Uncertainty** | Relies on subagent spawning | No uncertain capabilities |

---

## Benefits of New Architecture

1. ✅ **No uncertain agent capabilities** - Doesn't rely on hierarchical spawning
2. ✅ **Clear control flow** - Orchestrator sees and controls everything
3. ✅ **Better separation of concerns** - Planning → Execution → Merging
4. ✅ **Easier to debug** - Flat agent structure, visible TodoWrite
5. ✅ **More maintainable** - Each agent has ONE clear responsibility
6. ✅ **User visibility** - TodoWrite shows progress in real-time

---

## Validation Steps

After making changes:

1. **Verify all three files exist**:
   - [ ] agents/planning-coordinator.md (~180 lines)
   - [ ] agents/merge-coordinator.md (~160 lines)
   - [ ] commands/orc.md (Phase 6b updated to ~60 lines)

2. **Check orc.md uses reference-based approach**:
   - [ ] Phase 6b lists WHAT to pass to each agent (bullet points)
   - [ ] Phase 6b references agent files: "See agents/X.md for full specifications"
   - [ ] Phase 6b does NOT include full example prompts
   - [ ] orc.md total length is ~332 lines (not >400)

3. **Check agent responsibilities are clear**:
   - [ ] Planning coordinator: creates worktrees, returns YAML plan
   - [ ] Implementation agents: implement chunks in worktrees
   - [ ] Merge coordinator: merges worktrees, handles conflicts, cleans up
   - [ ] Main orchestrator: spawns all agents, tracks progress

4. **Verify no hierarchical agent spawning**:
   - [ ] No agent file contains Task tool calls to spawn other agents
   - [ ] Merge coordinator resolves conflicts inline (no agent spawning)
   - [ ] All implementation agents spawned by orchestrator

5. **Check TodoWrite integration**:
   - [ ] orc.md Phase 6b creates TodoWrite with all steps (Step 2, item 5)
   - [ ] orc.md Phase 6b updates TodoWrite as agents complete (items 9, 12)

6. **Verify agent files have detailed context sections**:
   - [ ] planning-coordinator.md has "Context You Will Receive" with examples
   - [ ] merge-coordinator.md has "Context You Will Receive" with examples
   - [ ] implementation.md already has this section (from previous fixes)

---

## Success Criteria

When complete, the architecture should:
- ✅ Avoid uncertain subagent spawning capability
- ✅ Have main orchestrator spawn all agents directly (flat spawning model)
- ✅ Have clear separation: Planning → Execution → Merging
- ✅ Show visible progress via TodoWrite (created in orchestrator)
- ✅ Have flat agent structure (easier to debug)
- ✅ Maintain all previous functionality (BASE path unchanged)
- ✅ Keep orc.md concise (~332 lines) using reference-based approach
- ✅ Have detailed agent specifications in agent files (not in orc.md)

---

## Testing Recommendation

After implementing these changes, test with a simple COMPLEX task:

**Example test task**: "Add user authentication with backend API, frontend UI, and database schema"

Expected flow:
1. Planning coordinator creates worktrees, returns YAML plan
2. Orchestrator spawns 3 implementation agents in parallel
3. Agents implement chunks, return summaries
4. Merge coordinator merges worktrees sequentially
5. Quality review agents check the integrated code
6. Final PR created

**If this works, the architecture is validated.**

---

Report completion with: "Architectural revision complete. Created planning-coordinator.md, merge-coordinator.md. Updated orc.md Phase 6b with flat agent spawning model."
