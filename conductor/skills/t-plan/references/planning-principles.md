# Planning Principles Reference

Load this file when stuck on plan quality or need to improve decision-forcing questions.

## Table of Contents

1. [Questions That Force Decisions](#questions-that-force-decisions)
2. [Patterns to Avoid](#patterns-to-avoid)
3. [Success Criteria](#success-criteria)

---

## Questions That Force Decisions

Before exploring solutions, force these choices:

**Scope decisions**
- "What's the simplest version that still delivers value?" -> Forces MVP boundary
- "If you could only ship one capability, which?" -> Forces prioritization

**Quality decisions**
- "What would make this a failure even if it 'works'?" -> Forces success criteria beyond "it runs"
- "Who's the handoff audience: you tomorrow, a teammate, or a future AI agent?" -> Forces documentation depth

**Build vs integrate decisions**
- "Is this core to your product or commodity infrastructure?" -> Forces build-vs-buy stance
- "What existing pattern in the codebase is this most similar to?" -> Forces reuse consideration

---

## Patterns to Avoid

Plans fail when implementers are left guessing. Avoid these patterns:

**Vague action items**
- "Implement the feature" -> Instead: "Create `src/services/feature.ts` with `handleX()` function following pattern in `src/services/auth.ts:45-60`"

**Assumed context**
- "Use the standard approach" -> Instead: Name the file containing the pattern and line numbers

**Pseudocode in research notes**
- `// handle the thing here` -> Instead: Working code snippets from docs that compile

**Missing decision rationale**
- "We chose Zustand" -> Instead: "We chose Zustand because [reason]. Rejected Redux (overkill), Context (scaling issues)"

**No failure guidance**
- Assumes happy path only -> Instead: Include "If X fails, check Y" for likely failure points

**Scope creep**
- "Could also add X later" mixed with core items -> Instead: Explicit "Out of scope" section

---

## Success Criteria

A plan is "done right" when:

1. **Zero-context executable**: An implementer with only PLAN.md can complete the work without asking "what did you mean by X?"

2. **Decisions are justified**: Every key choice includes rationale AND rejected alternatives.

3. **Research is actionable**: Code snippets compile and run. Gotchas are specific.

4. **Checklist is granular**: 20-100 items, each a single focused unit of work, each naming specific files.

5. **Verification is observable**: Each phase ends with concrete checks: "tests pass", "endpoint returns 200", not "it works."

6. **Failure paths documented**: The 2-3 most likely failure points include "If X fails, check Y" guidance.

7. **Scope is bounded**: Explicit "out of scope" list prevents over-reach.
