---
name: mega-plan
description: Turn discussions into executable, self-contained implementation plans. NOT for: quick fixes, single-file changes, bug fixes with known solutions, tasks under 30 minutes, exploratory spikes. USE for: multi-file features, architectural changes, unfamiliar tech requiring research, handoff to future sessions or other agents. Triggers: "plan this feature", "create implementation plan", "mega plan", "write a PLAN.md", "plan before implementing", "thorough planning", "help me design this".
---

# Mega-Plan Skill

Transform conversations into rock-solid implementation plans. The conversation IS the planning process.

<core_philosophy>
- **One output**: PLAN.md - no JSON, no state files, no orchestration overhead
- **Self-contained**: Implementer needs nothing beyond the plan
- **Research visible**: User sees findings, guides direction
- **Iterative**: User reviews drafts, suggests changes before finalizing
</core_philosophy>

<design_thinking>
## Questions That Force Decisions

Before exploring solutions, force these choices:

**Scope decisions**
- "What's the simplest version that still delivers value?" → Forces MVP boundary
- "If you could only ship one capability, which?" → Forces prioritization

**Quality decisions**
- "What would make this a failure even if it 'works'?" → Forces success criteria beyond "it runs"
- "Who's the handoff audience: you tomorrow, a teammate, or a future AI agent?" → Forces documentation depth

**Build vs integrate decisions**
- "Is this core to your product or commodity infrastructure?" → Forces build-vs-buy stance
- "What existing pattern in the codebase is this most similar to?" → Forces reuse consideration

Don't proceed to EXPLORE until the user has committed to answers. Vague answers like "it depends" mean the question wasn't specific enough—rephrase with concrete options.
</design_thinking>

<planning_anti_patterns>
## Patterns to Avoid

Plans fail when implementers are left guessing. Avoid these patterns:

**Vague action items**
- "Implement the feature" → Instead: "Create `src/services/feature.ts` with `handleX()` function following pattern in `src/services/auth.ts:45-60`"
- "Add proper error handling" → Instead: List the 3-5 specific errors, where caught, what happens for each

**Assumed context**
- "Use the standard approach" → Instead: Name the file containing the pattern and line numbers
- "Follow existing conventions" → Instead: Specify which file demonstrates the convention

**Pseudocode in research notes**
- `// handle the thing here` → Instead: Working code snippets from docs that compile and can be adapted
- "See the docs for details" → Instead: Extract the specific setup snippet and list 2-3 gotchas

**Missing decision rationale**
- "We chose Zustand" → Instead: "We chose Zustand because [reason]. Rejected Redux (overkill), Context (scaling issues in `CartContext.tsx`)"

**No failure guidance**
- Assumes happy path only → Instead: Include "If X fails, check Y" for the 2-3 most likely failure points

**Scope creep**
- "Could also add X later" mixed with core items → Instead: Explicit "Out of scope" section; if not in checklist, it doesn't exist

**Orphan checklist items**
- Items with no connection to research → Instead: Reference the relevant research section: "Using pattern from Research Notes section 2"
</planning_anti_patterns>

<planning_success_criteria>
## Success Criteria

A plan is "done right" when:

1. **Zero-context executable**: An implementer with only PLAN.md (no conversation history) can complete the work without asking "what did you mean by X?" Test: would a different person reach the same implementation?

2. **Decisions are justified**: Every key choice includes rationale AND rejected alternatives. The implementer never wonders "should I try Y instead?"

3. **Research is actionable**: Code snippets compile and run. Gotchas are specific. Doc links point to relevant sections—not just homepages.

4. **Checklist is granular**: 20-100 items, each completable in 5-30 minutes, each naming specific files. No item hides complexity behind vague phrasing.

5. **Verification is observable**: Each phase ends with concrete checks: "tests pass", "endpoint returns 200", not "it works."

6. **Failure paths documented**: The 2-3 most likely failure points include "If X fails, check Y" guidance.
</planning_success_criteria>

<planning_complexity>
## Match Process to Scope

**Lightweight process** (skip Steps 2-4, draft directly):
- Single-file changes with clear requirements
- Features mirroring existing patterns ("add delete like we have create")
- Bug fixes where cause and solution are known
- Tasks completable in under 1 hour

**Standard process** (all 6 steps):
- Multi-file features touching 3+ areas
- New integrations requiring library research
- Cross-cutting concerns (auth, logging, error handling)
- Handoff to another session or agent

When in doubt, use standard. It's easier to skip steps than recover from under-planning.

**Extended process** (multiple research iterations):
- Architectural decisions with long-term consequences
- Evaluating multiple technology stacks
- Features with security/compliance implications
- Multi-week implementations needing phased delivery

**Signals you're over-planning**:
- More time researching than implementation would take
- User is waiting for you to just start coding
- Plan complexity exceeds feature complexity

**Signals you're under-planning**:
- Unsure which files to modify
- Can't estimate if this is 1 hour or 1 week
- Don't know if existing solutions exist

Don't create a 50-item checklist for adding a button. Don't create a 5-item checklist for a new auth system.
</planning_complexity>

<planning_guidelines>
## Planning Guidelines

### Name Files, Not Concepts

<example_good title="Grounded in codebase">
- [ ] **Create session service** (`src/services/session.ts`)
  - Export `createSession(userId: string): Promise<Session>`
  - Follow pattern in `src/services/auth.ts:45-60`
  - Expected: `npm run typecheck` passes
</example_good>

<example_bad title="Abstract">
- [ ] Implement session management
- [ ] Make sure it handles edge cases
</example_bad>

### Include Rejected Alternatives

<example_good title="Decision with context">
| Decision | Choice | Rationale | Rejected |
|----------|--------|-----------|----------|
| State | Zustand | Already in deps, matches `src/stores/` | Redux (overkill), Context (scaling issues in CartContext) |
</example_good>

<example_bad title="Decision without context">
We'll use Zustand for state.

*Implementer wonders: "Is Redux better? Should I check?"*
</example_bad>

### Include Escape Hatches for Known Risks

<example_good title="Failure guidance included">
- [ ] **Configure OAuth callback**
  - Register callback URL in Google Console
  - Expected: Login redirects back with session cookie

  **If "redirect_uri_mismatch" error**:
  - Check `NEXTAUTH_URL` matches registered URL exactly (including trailing slash)
  - Google Console changes take ~5 min to propagate
</example_good>

<example_bad title="No failure guidance">
- [ ] Configure OAuth callback
  - Handle the OAuth flow
  - Expected: Login works
</example_bad>
</planning_guidelines>

---

## Step 1: UNDERSTAND

**Goal**: Establish clear problem statement before any exploration.

<fresh_start>
If user provided a feature description with no prior discussion:

Ask clarifying questions (max 3-4):
- What's the core goal? What problem does this solve?
- Any technical constraints or preferences?
- Scope boundaries - what's explicitly out of scope?
- Integration points with existing features?

Use `AskUserQuestion` tool to gather answers efficiently.
</fresh_start>

<mid_conversation>
If prior discussion exists about this feature:

1. Synthesize what was discussed:
   "Based on our discussion, I understand we want to: [summary]"

2. Confirm understanding and ask about gaps:
   "Is this accurate? Anything I'm missing?"

3. Only ask questions for truly unresolved points
</mid_conversation>

**Output**: Clear 2-3 sentence problem statement that anchors all subsequent work.

---

## Step 2: EXPLORE

**Goal**: Ground the proposal in reality - what do we have, what exists in the ecosystem.

### 2a. Codebase Exploration

Spawn an **Explore subagent** to understand the codebase:

```
<task_prompt>
Explore the codebase to understand:
1. Tech stack, frameworks, patterns in use
2. Existing code related to [problem area]
3. Project structure and conventions
4. Already installed dependencies (package.json, requirements.txt, etc.)

Focus on: [specific areas relevant to the problem]

Report findings as structured context for planning.
</task_prompt>
```

Use `Task` tool with `subagent_type: "Explore"`.

### 2b. Solution Scout

After codebase exploration, spawn a **general-purpose subagent** to scout existing solutions:

```
<task_prompt>
You are a Solution Scout. Given this context:

**Problem**: [problem statement]
**Existing stack**: [from codebase exploration]
**Installed dependencies**: [list from exploration]

Find existing solutions we shouldn't reinvent.

SEARCH PRIORITY:
1. Features already in INSTALLED deps (zero new deps)
   "You have React Query - it already handles caching"
2. Plugin for an INSTALLED dep (tiny dep, smooth integration)
   "Add @tanstack/react-query-devtools - extends what you have"
3. Well-designed library that bundles the solution (one dep, not five)
   "Add Tanstack Table - sorting, filtering, pagination included"
4. Build custom (only if truly unique to your domain)

Research:
- "[existing-lib] plugin for [problem]"
- "best [framework] library for [problem] 2026"

For top 2-3 options, report:
- Name and what it does
- Maintenance status (last release, GitHub stars)
- Integration complexity with existing stack
- Recommendation with rationale
</task_prompt>
```

Use `Task` tool with `subagent_type: "general-purpose"`.

**Output**: Codebase context report + industry solutions report.

---

## Step 3: PROPOSE APPROACH

**Goal**: Present an informed approach for user approval before deep research.

Present a proposal grounded in exploration findings:

```
Based on exploration:
- [Codebase findings: tech stack, relevant existing code]
- [Installed dependencies that matter]

Based on solution scout:
- [Top solutions found, why they fit or don't]

**Recommendation**: [specific approach]

Why this over alternatives:
- [Rationale 1]
- [Rationale 2]

Does this direction make sense? Any concerns?
```

Wait for user confirmation before proceeding. If user disagrees or has concerns, iterate on the approach.

---

## Step 4: RESEARCH

**Goal**: Get setup patterns, working examples, and gotchas for the approved approach.

For each technology in the approved approach:

### Research Strategy

**Option 1: Context7 MCP (if available)**
```
1. resolve_library_id("[library-name]")
2. get_library_docs(id, topic="[relevant-topic]")
```

**Option 2: Web Search + Fetch**
```
1. WebSearch: "[library] [topic] setup guide 2026"
2. WebFetch: Official docs page
```

### Extract for Each Technology

- **Setup snippet**: Minimal working example (not pseudocode)
- **Gotchas**: 2-3 common mistakes or requirements
- **Docs link**: Where to learn more

### Handle Research Reveals Issues

If research uncovers problems with the approach:
```
Research found that [X] doesn't support [Y].

Alternative approaches:
1. [Option A with rationale]
2. [Option B with rationale]

Which direction?
```

Return to Step 3 if approach needs to change.

**Output**: Research notes ready to embed in plan.

---

## Step 5: DRAFT PLAN

**Goal**: Generate PLAN.md draft for user review and iteration.

Generate the plan following the template in `references/plan-template.md`.

<implementer_context>
The plan will be executed by an AI agent (or human) who has NO access
to this conversation. They cannot ask "what did you mean by X?" -
everything must be explicit in the plan.

Include:
- Codebase context from exploration
- WHY decisions were made (not just WHAT)
- Rejected alternatives (so they don't re-explore)
- Working code snippets (not pseudocode)
- Known gotchas
- How to research more (MCP tool hints, doc links)
</implementer_context>

<checklist_guidance>
Per Anthropic's guidance: granular checklists (20-100 items) beat vague high-level plans.

Break down into specific, actionable steps:
- Each step names the file(s) to modify
- Each step describes what to change
- Order steps by dependencies
- Include verification steps
</checklist_guidance>

Present the draft to the user in the conversation. Ask for feedback.

---

## Step 6: FINALIZE

**Goal**: Activate plan mode, write the plan, and offer execution options.

### 6a. Iterate on Draft

Incorporate user feedback. Common adjustments:
- Add missing context or rationale
- Adjust scope (add/remove items)
- Reorder or regroup checklist items
- Add more detail to specific sections

Repeat until user is satisfied.

### 6b. Activate Plan Mode

Use `EnterPlanMode` tool to enter Claude Code's built-in plan mode.

### 6c. Write the Plan

1. Create directory if needed:
   ```bash
   mkdir -p .claude/plans
   ```

2. Write plan to `.claude/plans/<feature-slug>.md`

### 6d. Exit Plan Mode with Options

Use `ExitPlanMode` tool and present execution options:

```
Plan written to: .claude/plans/<feature-slug>.md

How would you like to proceed?

1. **Execute now** - I'll implement this plan in this session
2. **Spawn agent** - I'll spawn a Task agent to implement the plan
3. **Save for later** - Plan is saved; start a fresh session when ready

Which option?
```

Use `AskUserQuestion` to get user's choice, then act accordingly.

---

## Quick Reference

| Step | Purpose | Output |
|------|---------|--------|
| UNDERSTAND | Clarify goal | Problem statement |
| EXPLORE | Ground in reality | Codebase + solutions report |
| PROPOSE | Get direction approval | Approved approach |
| RESEARCH | Get implementation details | Setup snippets + gotchas |
| DRAFT | Show plan for review | Draft PLAN.md |
| FINALIZE | Write and offer execution | Final plan + next steps |

<planning_closing>
## Closing Principle

A plan succeeds when the implementer never thinks "I wish they had told me that." The implementer's context window starts empty—encode everything you know.
</planning_closing>
