# Plan Template Reference

This template defines the structure for PLAN.md files. Each section serves a specific purpose for the implementer.

---

## Template Structure

```markdown
# [Feature Name]

> **For the implementer**: This plan is self-contained. You don't need
> the conversation that produced it. Everything you need is here.

## Codebase Context

Summary of what exploration found:

- **Tech stack**: [frameworks, languages, key libraries]
- **Relevant existing code**:
  - `path/to/file.ts` - [what it does, why it matters]
  - `path/to/other.ts` - [what it does, why it matters]
- **Installed dependencies**: [packages relevant to this feature]
- **Patterns in use**: [architecture patterns, conventions]

**Pointers** (if you need more context):
- Canonical implementation: `path/to/canonical.ts:L-L` (search anchor: `SYMBOL_NAME`)
- Usage examples: `rg "Pattern" src/dir/`
- Related tests: `path/to/__tests__/file.test.ts`
- Entrypoint: `src/entry.ts` → follows to `src/handlers/`

## Baseline

*Skip this section for greenfield features where nothing exists yet.*

What exists now (observable, not code narration):

- [Current behavior 1 - what the system does today]
- [Current behavior 2 - relevant to what we're changing]

**Repro** (if applicable):
```bash
# Command to observe current behavior
curl -X POST /api/endpoint
# Returns: { "current": "response" }
```

**Must preserve** (invariants):
- [Behavior that must NOT change]
- [API compatibility requirement]
- [Schema stability requirement]

## Goal

[2-3 sentences describing what this feature accomplishes and why it matters]

## Constraints

- [Technical constraint 1]
- [Business/scope constraint 2]
- [Performance/security constraint 3]

## Scope Boundaries

**Out of scope** (do not implement, do not refactor):
- [Explicit non-goal 1]
- [Area not to touch: `path/to/legacy/`]
- [Feature to defer: "X is for a future PR"]

**Invariants** (must not change):
- [API compatibility: existing endpoints keep same signatures]
- [Schema stability: no breaking migrations]
- [No new dependencies unless explicitly approved]

**Assumptions** (if false, stop and ask):
- [Assumes X service is running]
- [Assumes Y config exists]

**Abort conditions** (stop immediately, do not guess):
- [Tests fail for unrelated reasons]
- [Build breaks before you made changes]
- [Discovery reveals architecture incompatible with approach]

**Clarification triggers** (pause and ask user):
- [Requirements seem ambiguous]
- [Multiple valid interpretations exist]
- [Need to modify more than N files outside expected scope]

## Key Decisions

| Decision | Choice | Rationale | Rejected Alternatives |
|----------|--------|-----------|----------------------|
| [What needed deciding] | [What we chose] | [Why this choice] | [What we didn't choose and why] |
| Auth library | BetterAuth | Already installed, supports OAuth | NextAuth (new dep), custom (effort) |
| State management | Zustand | Matches existing patterns | Redux (overkill), Context (scaling) |

## Research Notes

### [Library/Framework 1]

**What it does**: [Brief description]

**Setup**:
```typescript
// Minimal working example - copy and adapt
import { thing } from 'library';

const config = {
  option: 'value',
};

export const instance = createThing(config);
```

**Gotchas**:
- [Common mistake 1 - how to avoid]
- [Common mistake 2 - how to avoid]
- [Requirement that's easy to miss]

**More info**:
- Docs: [direct link to relevant docs page]
- Or use Context7 MCP: `get_library_docs("library-id", "topic")`

### [Library/Framework 2]

[Same structure as above]

## Acceptance Criteria

*What "done" actually means (not just "tests pass"):*

- [ ] [Specific outcome 1: "User can log in with OAuth"]
- [ ] [Specific outcome 2: "Session persists across browser refresh"]
- [ ] [Specific outcome 3: "Error messages are user-friendly, not stack traces"]
- [ ] [Performance: "Response time <500ms under normal load"]

## Implementation Checklist

Work through in order. Each step should leave the codebase in a working state.

### Phase 1: [Foundation/Setup]

- [ ] **Create config file** (`src/config/feature.ts`)
  - Define configuration schema
  - Export typed config object
  - Expected: TypeScript compiles, config is importable

- [ ] **Add environment variables** (`.env.example`, `.env`)
  - Add `FEATURE_API_KEY`, `FEATURE_SECRET`
  - Document in `.env.example`
  - Expected: App starts without missing env errors

### Phase 2: [Core Implementation]

- [ ] **Implement main service** (`src/services/feature.ts`)
  - Create `FeatureService` class
  - Implement `doThing()` method using pattern from Research Notes
  - Expected: Unit tests pass (write them first)

- [ ] **Add API endpoint** (`src/api/feature.ts`)
  - POST `/api/feature` endpoint
  - Validate input, call service, return response
  - Expected: Can curl endpoint successfully

### Phase 3: [Integration]

- [ ] **Connect to UI** (`src/components/FeatureButton.tsx`)
  - Add button component
  - Wire up to API endpoint
  - Handle loading/error states
  - Expected: Button works in browser

- [ ] **Add to navigation** (`src/layout/Sidebar.tsx`)
  - Add menu item for new feature
  - Expected: Feature accessible from sidebar

### Phase 4: [Polish]

- [ ] **Add error handling**
  - Graceful errors in service layer
  - User-friendly error messages in UI
  - Expected: Errors don't crash app

- [ ] **Add loading states**
  - Skeleton/spinner while loading
  - Expected: Good UX during async operations

### Verification

- [ ] **End-to-end test**: [Describe the full flow to test]
- [ ] **Edge cases**: [List specific edge cases to verify]
- [ ] **Build passes**: `npm run build` succeeds
- [ ] **Tests pass**: `npm test` succeeds
- [ ] **Lint clean**: `npm run lint` passes
```

---

## Section Purpose Reference

| Section | Purpose | What Goes Wrong Without It |
|---------|---------|---------------------------|
| **Codebase Context** | Ground implementer in the project | Incompatible choices, reinventing existing code |
| **Pointers** | Guide exploration when stuck | Agent fans out into many branches, wastes context |
| **Baseline** | Starting state being changed | Agent builds on false assumptions about current state |
| **Goal** | Orient the implementer | Wrong thing built, wrong scope |
| **Constraints** | Boundaries and limits | Over-engineering, missed requirements |
| **Scope Boundaries** | Prevent over-reach | Scope creep, refactoring things that shouldn't change |
| **Key Decisions** | Explain WHY, not just WHAT | Second-guessing, changing approach mid-way |
| **Rejected alternatives** | Prevent re-exploration | Wasted time reconsidering rejected options |
| **Research Notes** | Working code examples | Broken code, hitting known gotchas |
| **Gotchas** | Common mistakes to avoid | Hours debugging known issues |
| **More info** | Self-serve research | Implementer stuck, doesn't know how to learn more |
| **Acceptance Criteria** | Definition of done | "Tests pass" but feature doesn't actually work |
| **Checklist** | Granular steps | Skipped steps, lost track, declared done prematurely |
| **Verification** | Mechanical checks | Shipped broken/incomplete work |

---

## Checklist Guidelines

**Granularity**: Aim for 20-100 items. Each item should be:
- Completable in one focused work session
- Independently verifiable
- Clear about which file(s) to touch

**Ordering**: Dependencies first. Each step should leave codebase working.

**Format**: Each item includes:
- Action verb (Create, Add, Implement, Update, Connect)
- File path(s) in parentheses
- Brief description of what to do
- Expected outcome after completion

**Phases**: Group related items. Common phases:
1. Foundation/Setup
2. Core Implementation
3. Integration
4. Polish/Verification
