# Prompt: Apply High-Priority Review Fixes

**Context**: You recently completed the orchestration plugin refactoring (commit 6cb0d84). A comprehensive review identified 5 high-priority improvements needed before the plugin is ready for production use.

**Your task**: Apply these specific fixes to the agent files. Follow the instructions precisely.

---

## Fix 1: Remove Emojis (Project Standard Violation)

**Why**: Project constitution states "Keep files ASCII; avoid emojis unless existing content justifies otherwise."

**Files to fix**:

1. `/home/b3ngous/projects/claude-plugins/orchestration/agents/coordinator.md`
   - **Line 169**: Change `✅ COMPLEX implementation complete` to `COMPLEX implementation complete`

2. `/home/b3ngous/projects/claude-plugins/orchestration/agents/implementation.md`
   - **Line 89**: Change `✅ Implementation complete:` to `Implementation complete:`

**Action**: Use Edit tool to remove the ✅ emoji from both lines.

---

## Fix 2: Add Statelessness Statement to Coordinator Agent

**Why**: Agents must explicitly understand they run in isolated contexts and cannot access parent state.

**File**: `/home/b3ngous/projects/claude-plugins/orchestration/agents/coordinator.md`

**Location**: After line 12 (after "You do not implement code yourself. You delegate to implementation agents.")

**Add this section**:

```markdown
---

## Important: You Are Stateless

You are running in an isolated agent context, separate from the parent orchestrator.

**What this means**:
- You **cannot access** the parent orchestrator's TodoWrite or conversation state
- You **cannot send messages** to the orchestrator after being spawned
- You **must include all information** in your final return message
- You receive **all context upfront** in your spawning prompt (task breakdown, architecture guidance, files to read, base branch name)
- Once you return your final message, your context is destroyed - no follow-up questions possible

**Therefore**:
- Make decisions autonomously based on the provided context
- Include complete summaries in your return message
- Don't assume you can ask for clarification later
- Plan your work to be completely self-contained
- If something is unclear, make reasonable assumptions based on architecture guidance

---
```

---

## Fix 3: Add Statelessness Statement to Implementation Agent

**File**: `/home/b3ngous/projects/claude-plugins/orchestration/agents/implementation.md`

**Location**: After line 9 (after "You will receive detailed instructions about what to build, where to work, and what architecture to follow.")

**Add this section**:

```markdown
---

## Important: You Are Stateless

You are running in an isolated agent context, separate from the parent orchestrator.

**What this means**:
- You **cannot access** the orchestrator's TodoWrite or conversation state
- You **cannot send messages** back to the orchestrator during execution
- You **must include all information** in your final return message
- You receive **all context upfront** (task description, branch/worktree location, architecture guidance, files to read)
- Once you return your final message, your context is destroyed - no follow-up possible

**Therefore**:
- Work autonomously with the provided context
- Make implementation decisions independently based on architecture guidance
- Include complete summary when returning
- If something is unclear in the requirements, make reasonable assumptions following the architecture patterns you observe in the codebase
- Don't wait for clarification - proceed with best judgment

---
```

---

## Fix 4: Add Statelessness Statement to Merge-Resolver Agent

**File**: `/home/b3ngous/projects/claude-plugins/orchestration/agents/merge-resolver.md`

**Location**: After line 9 (after "You will be spawned by the coordinator agent when merging worktrees to the base branch produces conflicts.")

**Add this section**:

```markdown
---

## Important: You Are Stateless

You are a one-shot specialist running in an isolated agent context.

**What this means**:
- You **cannot access** the coordinator's state or TodoWrite
- You **cannot ask questions** to the coordinator during conflict resolution
- You **must complete the resolution** and return summary in one execution
- You receive **all conflict context** upfront (base branch, merging branch, conflict files, conflict markers)
- Once you return your final message, your context is destroyed

**Therefore**:
- Analyze conflicts independently using only the provided context
- Make resolution decisions autonomously
- Include detailed explanation in your return message
- No follow-up questions possible - resolve the conflict completely in one pass
- If resolution approach is ambiguous, choose the most maintainable option

---
```

---

## Fix 5: Add Worktree Path Retrieval Instructions to Coordinator

**Why**: Coordinator creates worktrees but doesn't explain how to get the worktree path to pass to implementation agents.

**File**: `/home/b3ngous/projects/claude-plugins/orchestration/agents/coordinator.md`

**Location**: In section "### 1. Create Worktrees", after the example block (after line 40, before "Each worktree gets its own branch from base.")

**Add this text**:

```markdown

After creating each worktree, retrieve its path and branch information:

```bash
/worktree:open <worktree-name>
```

This returns:
- Worktree absolute path: `/path/to/worktree/<worktree-name>`
- Branch name: `<worktree-name>-branch`

You'll need these to pass to implementation agents in the next step.

Example:
```bash
/worktree:create wt-backend --base feat/user-auth
/worktree:open wt-backend
# Returns: /home/user/project/.worktrees/wt-backend, branch: wt-backend-branch
```

Store this information for each worktree to use in agent prompts.
```

---

## Fix 6: Add Explicit Task Tool Blocking Behavior to Coordinator

**Why**: Coordinator needs to understand how monitoring agent completion actually works.

**File**: `/home/b3ngous/projects/claude-plugins/orchestration/agents/coordinator.md`

**Location**: Replace the current "### 3. Monitor Completion" section (lines 76-81)

**Replace with**:

```markdown
### 3. Monitor Completion

**How Task tool returns work**:

When you spawn agents using the Task tool, the tool **blocks** until the agent completes and returns its final message.

When spawning multiple agents in parallel (multiple Task tool calls in one message):
- All Task tool calls execute concurrently
- Your execution pauses until **all agents** have returned
- You then receive each agent's final return message
- Check each message for success or errors

**Example**:
```
You spawn 3 agents in parallel:
- Task tool (Agent A for backend)
- Task tool (Agent B for frontend)
- Task tool (Agent C for database)

[System blocks your execution]

Agent B completes first → returns message
Agent A completes second → returns message
Agent C completes third → returns message

[System unblocks your execution with all 3 messages]

You proceed to review all return messages and begin merging.
```

**Check for errors**:
Review each agent's return message. If any agent reports errors or incomplete work:
1. Note the issue in your final return message
2. Include which chunk had problems
3. The orchestrator will decide whether to continue or abort
```

---

## Fix 7: Add Error Handling to Coordinator

**Why**: Coordinator needs to handle agent failures gracefully.

**File**: `/home/b3ngous/projects/claude-plugins/orchestration/agents/coordinator.md`

**Location**: After the new "### 3. Monitor Completion" section, before "### 4. Merge Worktrees to Base"

**Add this section**:

```markdown

---

### 3.5. Handle Agent Errors (If Any)

After all agents return, review their completion messages.

**If an agent reports errors or incomplete work**:

1. **Assess severity**:
   - **Blocking**: Agent couldn't complete its chunk (build errors, critical missing info)
   - **Non-blocking**: Agent completed with minor issues or warnings

2. **For blocking errors**:
   ```
   Do NOT proceed to merging.

   Return to orchestrator immediately with error report:

   "COMPLEX implementation FAILED

   **Error in chunk**: [chunk name]
   **Agent report**: [copy agent's error message]
   **Status**: Other chunks may have completed successfully
   **Recommendation**: Fix blocking issue and retry, or abort

   **Successful chunks** (if any):
   - [list chunks that completed successfully]

   **Worktrees NOT merged**: All worktrees still exist for debugging
   "
   ```

3. **For non-blocking issues**:
   - Note them in your completion summary
   - Continue with merging process
   - Include warnings in final return message

---
```

---

## Execution Checklist

Perform these actions in order:

- [ ] **Fix 1**: Remove ✅ emoji from coordinator.md line 169
- [ ] **Fix 1**: Remove ✅ emoji from implementation.md line 89
- [ ] **Fix 2**: Add statelessness section to coordinator.md after line 12
- [ ] **Fix 3**: Add statelessness section to implementation.md after line 9
- [ ] **Fix 4**: Add statelessness section to merge-resolver.md after line 9
- [ ] **Fix 5**: Add worktree path retrieval instructions to coordinator.md after line 40
- [ ] **Fix 6**: Replace "Monitor Completion" section in coordinator.md (lines 76-81)
- [ ] **Fix 7**: Add error handling section to coordinator.md after new "Monitor Completion"

---

## Validation

After making changes, verify:

1. **No emojis remain** in any agent file
2. **All three agents** have statelessness statements
3. **Coordinator** has worktree path retrieval instructions
4. **Coordinator** has explicit Task tool blocking behavior
5. **Coordinator** has error handling section
6. **Line numbers may shift** - that's expected as you add content

---

## Success Criteria

When complete:
- All 7 fixes applied
- No emojis in agent files
- Agents understand they're stateless
- Coordinator knows how to get worktree paths
- Coordinator knows how Task tool blocking works
- Coordinator can handle agent failures gracefully

Report completion with: "Applied all 7 high-priority review fixes. Files updated: coordinator.md, implementation.md, merge-resolver.md"

---

## Note

These are the **HIGH PRIORITY** fixes from the comprehensive review. After these are applied, the plugin will be production-ready. Medium and low priority improvements can be done iteratively based on real-world usage.
