---
name: t-plan
description: Thorough planning for complex features using a 6-step orchestrator-subagent workflow. Turn discussions into executable, self-contained implementation plans. USE for: multi-file features, architectural changes, unfamiliar tech requiring research, handoff to future sessions or other agents. SKIP for quick fixes, single-file changes, or low-complexity tasks—use normal plan mode instead. Triggers: "plan this feature", "create implementation plan", "thorough plan", "t-plan", "write a PLAN.md", "plan before implementing", "help me design this".
hooks:
  PreToolUse:
    # Init: runs ONCE on first tool use when skill is active
    - matcher: "*"
      once: true
      hooks:
        - type: command
          command: bun "${CLAUDE_PLUGIN_ROOT}/hooks/t-plan-init.ts"
          timeout: 5
          description: T-plan session initialization
    # Coordinator: runs on every Task dispatch with phase marker
    - matcher: Task
      hooks:
        - type: command
          command: bun "${CLAUDE_PLUGIN_ROOT}/hooks/t-plan-coordinator.ts"
          timeout: 10
          description: T-plan state management
---

# T-Plan Skill (Thorough Planning)

Transform conversations into rock-solid implementation plans using a structured orchestrator-subagent workflow.

## Workflow Overview

```
INTENT → EXPLORE → [gate] → SCOUT → DRAFT → VALIDATE → PLAN
   ↑         ↑                  ↑       ↑         ↑        ↑
 orch.    subagent           subagent  orch.   subagent  orch.+user
```

| Step | Actor | Output |
|------|-------|--------|
| **INTENT** | Orchestrator | Clear intent (gate: can direct EXPLORE?) |
| **EXPLORE** | Subagent | Codebase insights (gate: trivial → skip?) |
| **SCOUT** | Subagent | Alternatives only (no docs) |
| **DRAFT** | Orchestrator | Initial approach (reads files, synthesizes) |
| **VALIDATE** | Subagent | Doc validation + snippets |
| **PLAN** | Orchestrator + User | Final plan, iterate until approved |

**Principles:**
- Subagents gather information
- Orchestrator synthesizes and decides
- Two gates: clarity (INTENT), complexity (EXPLORE)
- Single user checkpoint (PLAN)

<core_philosophy>
- **One deliverable**: `plan.md` (intermediate artifacts are for resumability and validation)
- **Lightweight state**: `state.json` exists only to coordinate subagent contract verification
- **Self-contained**: Implementer needs nothing beyond the plan
- **Research visible**: User sees findings, guides direction
- **Iterative**: User reviews drafts, suggests changes before finalizing
</core_philosophy>

---

## Protocol Markers (Required for Hook Automation)

T-plan uses skill-scoped hooks for automated state management:
- **Init hook** (`once: true`): Creates session directory on first tool use
- **Coordinator hook**: Updates state.json on Task dispatches with phase markers

### Phase Marker (in `description` parameter)

Include the phase marker to trigger automatic state management:

```
[T-PLAN PHASE=INTENT|EXPLORE|SCOUT|VALIDATE]
```

Example Task description:
```
[T-PLAN PHASE=EXPLORE] Explore codebase for authentication patterns
```

### Contract Output Marker (in `prompt` parameter)

Specify the expected output file:

```
CONTRACT_OUTPUT: .t-plan/${CLAUDE_SESSION_ID}/explore.md
```

The coordinator hook will:
1. Update `state.json` with the current phase
2. Truncate stale contract output (ensures fresh write)

Note: Session directory and `.gitignore` are created by the init hook on first tool use.

### Directory Structure

```
.t-plan/${CLAUDE_SESSION_ID}/
  state.json              # Phase tracking (managed by hook)
  intent.md               # Shared context (orchestrator writes)
  explore.md              # EXPLORE contract output (subagent writes)
  scout.md                # SCOUT contract output (subagent writes)
  draft-v001.md           # Versioned drafts (orchestrator writes)
  validation-v001.json    # VALIDATE contract output (subagent writes)
  plan.md                 # Final output (orchestrator writes)
```

---

## Step 1: INTENT [ORCHESTRATOR]

**Goal**: Capture user intent clearly enough to direct exploration.

### What to Do

1. Capture the user's request in their terms
2. Clarify ambiguities that would prevent focused exploration
3. Do NOT assume technologies or solutions

### Clarity Gate

Before proceeding, ask yourself:

> "Can I write a focused prompt for the EXPLORE subagent?"

- **NO** → Clarify with user, loop until yes
- **YES** → Proceed to EXPLORE

### Clarification Triggers

Clarify if:
- The scope is unclear ("add authentication" → OAuth? Session? Which pages?)
- The target is vague ("make it faster" → Which part? Page load? API? DB?)
- Multiple interpretations exist

### Example

```
User: "Add authentication"

Orchestrator thinks: Can I direct EXPLORE specifically? No.

Orchestrator asks: "To focus my exploration:
- OAuth (Google, GitHub) or username/password?
- Which pages need protection?
- Any existing auth patterns in the codebase?"

User: "Google OAuth, protect /dashboard and /settings"

Orchestrator thinks: Now I can direct EXPLORE. Proceed.
```

**Output**: Clear intent sufficient to guide exploration.

---

## Step 2: EXPLORE [SUBAGENT]

**Goal**: Understand the codebase relevant to the user's intent.

### Pre-Dispatch (Orchestrator)

Write intent to `.t-plan/${CLAUDE_SESSION_ID}/intent.md` (state management is automated by hook).

### Dispatch Explore Subagent

Use `Task` tool with `subagent_type: "Explore"`:

- **description**: `[T-PLAN PHASE=EXPLORE] Explore codebase for [specific area]`
- **prompt**:

```
CONTRACT_OUTPUT: .t-plan/${CLAUDE_SESSION_ID}/explore.md

READ: .t-plan/${CLAUDE_SESSION_ID}/intent.md

CONTRACT: Write findings to .t-plan/${CLAUDE_SESSION_ID}/explore.md
          Your output MUST start with a 1-2 line summary referencing
          at least one concrete detail from intent.md (proof-of-read).

TASK: Explore the codebase to understand:
1. Tech stack, frameworks, patterns in use
2. Existing code related to [specific area from INTENT]
3. Project structure and conventions
4. Installed dependencies relevant to this task

Focus on: [specific areas from INTENT]

Return INSIGHTS, not just file paths:
- "src/auth/session.ts handles session management (lines 45-120)"
- "Architecture: service layer → repository → database"
- "Flow: login → validate → create session → store token"
- "Already installed: better-auth, zod, drizzle"
```

### Expected Output

The subagent should return (and write to `explore.md`):
- **Key files**: What they do, not just paths
- **Architecture**: How components connect
- **Flows**: How data/control moves through the system
- **Dependencies**: What's already installed that's relevant

---

## Complexity Gate [ORCHESTRATOR]

After receiving EXPLORE results, assess:

> "Is this task trivially simple?"

Trivially simple means ALL of:
- Single file change
- Pattern already exists in codebase (copy-paste with modification)
- No external dependencies involved
- No architectural decisions needed

**If trivially simple:**
```
"Based on exploration, this appears straightforward:
- Single file: src/components/Button.tsx
- Pattern exists: similar to existing LoadingButton

Would you like to continue with normal plan mode instead of thorough planning?"
```

**If not trivially simple:** Continue to SCOUT.

---

## Step 3: SCOUT [SUBAGENT]

**Goal**: Find alternatives that might be simpler than the obvious approach.

### Dispatch Scout Subagent

Use `Task` tool with `subagent_type: "general-purpose"`:

- **description**: `[T-PLAN PHASE=SCOUT] Find simpler alternatives`
- **prompt**:

```
CONTRACT_OUTPUT: .t-plan/${CLAUDE_SESSION_ID}/scout.md

READ: .t-plan/${CLAUDE_SESSION_ID}/intent.md
READ: .t-plan/${CLAUDE_SESSION_ID}/explore.md

CONTRACT: Write findings to .t-plan/${CLAUDE_SESSION_ID}/scout.md
          Start with a 1-line summary referencing explore.md findings (proof-of-read).

TASK: You are an Alternatives Scout. Given this context:

**Intent**: [from intent.md]
**Codebase**: [from explore.md]
**Installed dependencies**: [from explore.md]

Search for alternatives to the obvious approach.

CRITERIA - Only report alternatives that are MEANINGFULLY simpler:
- Fewer dependencies
- Less code to write/maintain
- Better fits existing patterns
- More mature/stable solution

DO NOT:
- Query documentation (that's VALIDATE's job)
- Recommend alternatives that are marginally different
- Suggest options just to have options

RETURN:
- Alternatives worth considering (often: NONE)
- For each: what it is, why it's simpler, tradeoffs
- Or: "No simpler alternatives found. Proceed with [obvious approach]."
```

### Expected Output

The subagent writes to `scout.md`:
- "No simpler alternatives found" (common case)
- 1-2 alternatives with clear rationale

**No doc queries** - Scout evaluates alternatives, VALIDATE checks docs.

---

## Step 4: DRAFT [ORCHESTRATOR]

**Goal**: Synthesize all context and draft an initial approach.

### What You Have

At this point, the orchestrator has accumulated:
- **Intent**: Clear user goal from Step 1
- **Codebase insights**: Architecture, patterns, relevant files from Step 2
- **Alternatives**: Simpler options if any from Step 3

### What to Do

1. **Read key files as needed** - Targeted reads, not exhaustive
2. **Synthesize** - Combine intent + codebase + alternatives
3. **Draft approach** - Outline what will be built and how

### Draft Structure

```markdown
## Approach

**Goal**: [1-2 sentences]

**Key decisions**:
- [Decision 1]: [Choice] because [rationale]
- [Decision 2]: [Choice] because [rationale]

**Files to modify/create**:
- `path/to/file.ts` - [what changes]
- `path/to/new.ts` - [what it does]

**Approach outline**:
1. [High-level step 1]
2. [High-level step 2]
3. [High-level step 3]
```

**Output**: Draft approach ready for validation.

---

## Step 5: VALIDATE [SUBAGENT]

**Goal**: Check the draft approach against official documentation.

### Pre-Dispatch (Orchestrator)

Write draft to `.t-plan/${CLAUDE_SESSION_ID}/draft-v{NNN}.md` and update `state.json` with `draft_version: NNN`.

### Dispatch Validate Subagent

Use `Task` tool with `subagent_type: "general-purpose"`:

- **description**: `[T-PLAN PHASE=VALIDATE] Validate draft against documentation`
- **prompt**:

```
CONTRACT_OUTPUT: .t-plan/${CLAUDE_SESSION_ID}/validation-v001.json

READ: .t-plan/${CLAUDE_SESSION_ID}/intent.md
READ: .t-plan/${CLAUDE_SESSION_ID}/explore.md
READ: .t-plan/${CLAUDE_SESSION_ID}/scout.md (if present)
READ: .t-plan/${CLAUDE_SESSION_ID}/draft-v001.md

CONTRACT: Write validation to .t-plan/${CLAUDE_SESSION_ID}/validation-v001.json
          JSON format with draft_version field matching state (proof-of-read).

TASK: You are a Documentation Validator. Given the draft approach in draft-v001.md:

**Technologies involved**: [list from draft]

Check against official documentation:

1. Are we using RECOMMENDED patterns?
2. Any DEPRECATED APIs or anti-patterns?
3. What are the GOTCHAS or common mistakes?
4. Provide WORKING setup snippets (not pseudocode)

SOURCE PRIORITY:
1. Native MCPs (Bun, Next.js, etc.) - most authoritative
2. Context7 MCP - if library is indexed
3. Web search + official docs - fallback

OUTPUT FORMAT (validation-v001.json):
{
  "draft_version": 1,
  "status": "VALID" | "NEEDS_CHANGES",
  "confirmations": [...],
  "corrections": [...],
  "snippets": [...],
  "gotchas": [...],
  "doc_links": [...]
}
```

### Expected Output

The subagent writes to `validation-v{NNN}.json`:
- **Confirmation**: "Approach aligns with official recommendations"
- **Corrections**: "Docs recommend X instead of Y because..."
- **Snippets**: Working code examples
- **Gotchas**: Common mistakes to avoid

### VALIDATE → DRAFT Revision Loop

If `validation-v{NNN}.json` returns `status: "NEEDS_CHANGES"`:

1. Orchestrator updates the approach and writes `draft-v{NNN+1}.md`
2. Orchestrator updates `state.json` with `draft_version: NNN+1`
3. Re-dispatch VALIDATE with updated version in CONTRACT_OUTPUT path

The validation filename is derived from `draft_version` (e.g., `validation-v001.json` for `draft_version: 1`).

Proceed to PLAN only when validation returns `status: "VALID"`.

---

## Step 6: PLAN [ORCHESTRATOR + USER] [CHECKPOINT]

**Goal**: Present final plan for user approval.

### What to Do

1. **Incorporate VALIDATE feedback** - Update draft with corrections/snippets
2. **Enter plan mode** - Use `EnterPlanMode` tool
3. **Write `.t-plan/${CLAUDE_SESSION_ID}/plan.md`** - Following the template in `references/plan-template.md` (if Plan Mode writes elsewhere, copy the final plan here)
4. **Present to user** - Single checkpoint for iteration

### Plan Contents

Generate plan following template with:
- Codebase context (from EXPLORE)
- Goal and constraints (from INTENT)
- Key decisions with rationale (from DRAFT)
- Research notes with snippets (from VALIDATE)
- Implementation checklist (granular, 20-100 items)
- Verification steps

### User Iteration

Present plan and iterate until user approves:
- Add missing context
- Adjust scope
- Reorder checklist items
- Clarify scope boundaries

### On Approval

```
Plan written to: .t-plan/${CLAUDE_SESSION_ID}/plan.md

How would you like to proceed?

1. **Execute now** - I'll implement this plan in this session
2. **Spawn agent** - I'll spawn a Task agent to implement the plan
3. **Save for later** - Plan is saved; start a fresh session when ready
```

Use `AskUserQuestion` to get user's choice.

---

## Quick Reference

| Step | Actor | Gate | Output |
|------|-------|------|--------|
| INTENT | Orchestrator | Can direct EXPLORE? | Clear intent |
| EXPLORE | Subagent | — | Codebase insights |
| — | Orchestrator | Trivially simple? | Skip or continue |
| SCOUT | Subagent | — | Alternatives (often: none) |
| DRAFT | Orchestrator | — | Initial approach |
| VALIDATE | Subagent | — | Doc validation + snippets |
| PLAN | Orch. + User | User approval | Final PLAN.md |

---

<design_decisions>
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
</design_decisions>

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
- Items with no connection to research → Instead: Reference the relevant research section
</planning_anti_patterns>

<inclusion_framework>
## What to Include vs Omit

**Every template section is optional.** Include only when it reduces branching or expected regret.

### Include in Plan If:

1. **Reduces branching** - Agent would fork into 3+ approaches without this
2. **High consequence if wrong** - Mistakes cause broad breakage or wasted edits
3. **Not discoverable** - Can't be inferred from codebase or CLAUDE.md
4. **Task-specific delta** - Overrides or extends project-level rules
5. **Failure mode is non-obvious** - Error messages don't point to the solution

### Omit (Agent Discovers) If:

1. **Single file read reveals it** - package.json shows package manager
2. **Existing code demonstrates it** - Import style visible in any file
3. **CLAUDE.md covers it** - Project-wide conventions already documented
4. **Low consequence** - Wrong inference is easily caught and fixed

### Reference (Don't Duplicate) If:

- Info is project-stable → Point to CLAUDE.md
- Pattern exists in codebase → "Follow pattern in `file.ts:L-L`"
</inclusion_framework>

<planning_success_criteria>
## Success Criteria

A plan is "done right" when:

1. **Zero-context executable**: An implementer with only PLAN.md (no conversation history) can complete the work without asking "what did you mean by X?"

2. **Decisions are justified**: Every key choice includes rationale AND rejected alternatives. The implementer never wonders "should I try Y instead?"

3. **Research is actionable**: Code snippets compile and run. Gotchas are specific. Doc links point to relevant sections—not just homepages.

4. **Checklist is granular**: 20-100 items, each a single focused unit of work, each naming specific files. No item hides complexity behind vague phrasing.

5. **Verification is observable**: Each phase ends with concrete checks: "tests pass", "endpoint returns 200", not "it works."

6. **Failure paths documented**: The 2-3 most likely failure points include "If X fails, check Y" guidance.

7. **Scope is bounded**: Explicit "out of scope" list prevents over-reach. Agent knows when to stop and ask.
</planning_success_criteria>

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

<planning_closing>
## Closing Principle

A plan succeeds when the implementer never thinks "I wish they had told me that." The implementer's context window starts empty—encode everything you know.
</planning_closing>

---

## Manual Fallback (If Hooks Not Installed)

If the skill-scoped hooks are not working, manually manage state:

```bash
# Before first dispatch - create session directory and .gitignore
mkdir -p ".t-plan/${CLAUDE_SESSION_ID}"

cat > ".t-plan/.gitignore" << 'EOF'
*
!.gitignore
EOF

# Initialize state.json with INTENT phase
cat > ".t-plan/${CLAUDE_SESSION_ID}/state.json" << EOF
{
  "schema_version": 2,
  "session_id": "${CLAUDE_SESSION_ID}",
  "phase": "INTENT",
  "draft_version": 0,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# Before each subagent dispatch, update phase in state.json
# Remove stale output before dispatch
rm -f ".t-plan/${CLAUDE_SESSION_ID}/explore.md"
```

Note: SubagentStop hook for contract verification requires `/conductor:setup-hooks`.
