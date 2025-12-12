---
description: Write agent-ready GitHub issues (create new or edit existing)
---

# Issue Writer

You are writing a GitHub issue for the current project. The goal is to produce a clear, evidence-backed, agent-ready issue that a smaller model can implement safely.

## Step 0: Project Preflight (REQUIRED)

Before asking for the issue itself, gather and summarize local rules:

1. **Locate local guidance**
   - Look for files like: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `README.md`, `docs/`, ADRs, architecture/validator rules, testing docs.
   - If multiple rule files exist, follow the most specific scope first.

2. **Extract the key constraints**
   - Examples: architecture boundaries, error handling style, naming, allowed deps, test expectations, quality gates, directories you must not touch, etc.

3. **Record project-specific commands**
   - Identify the canonical commands for: lint/format, type-check, unit tests, integration tests, e2e, and any architecture/validation gates.

4. **If anything is unclear**
   - Ask the user a short clarifying question (max 2-3 questions total), e.g.:
     - "Which command(s) represent the project quality gates?"
     - "Any architecture or layering rules I must respect?"
     - "Preferred testing strategy for this repo?"

Make sure these rules are reflected in the issue's guardrails, plan, and validation sections.

---

## Step 1: Mode Selection

Ask which mode the user wants:

**Options:**
1. **Create** - Write a new issue from scratch.
2. **Edit** - Rewrite/improve an existing issue by number.

---

## Step 1b: Issue Type

Ask what type of issue this is:

**Options:**
1. **Implementation** - Ready for an agent to code (default).
2. **Design-only** - RFC/discussion, NOT for implementation yet.

### If DESIGN-ONLY:
- Skip "Implementation plan" entirely.
- Add this block at the top of the issue body:
```markdown
> **Agent Instructions: DO NOT IMPLEMENT**
> This is a design/discussion issue. Do not write code for this issue.
> Wait for a follow-up implementation issue after design is approved.
```
- Focus on: Goal, Context, Problem, Proposed approaches (plural), Trade-offs, Open questions.
- Suggest labels based on repo conventions (e.g., `design`, `rfc`, `discussion`).

---

## Step 2: Gather Input

### If CREATE mode:
Ask: "Describe the problem, bug, or feature you want to address."

If the description is underspecified, ask up to 2 follow-ups:
- Desired outcome / success definition.
- Affected area/module/path if known.
- Any constraints/deadlines.

### If EDIT mode:
Ask: "What is the issue number to edit?"
Then fetch the existing issue:
```bash
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
gh issue view --repo "$REPO" <number> --json title,body,labels
```

---

## Step 3: Preflight Research (REQUIRED)

Before writing the issue, gather evidence. Keep research proportional to size: a quick scan for small issues, deeper investigation for large ones.

1. **Identify the problem and impact**
   - User-facing bug, correctness, performance, flakiness, CI cost, architecture violations, etc.

2. **Collect evidence from the codebase**
   - Locate relevant files using search.
   - Quote exact behaviors with `file:line` references and a stable anchor (see Style Guidelines).
   - Check relevant git history if needed:
     ```bash
     git log --oneline -10 -- <file>
     ```

3. **Determine priority**
   - **must-fix**: correctness/user/CI blocker.
   - **nice-to-have**: improvement/cleanup/optimization.

4. **Check for related issues**
   ```bash
   REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
   gh issue list --repo "$REPO" --search "keyword" --state all --limit 10
   ```

---

## Step 4: Write the Issue Body

Default to the Small Issue Template as the fast path. Only add extra sections or switch to the Large Issue template when the work is broad (multi-file, cross-module, or likely more than a day). Keep detail proportional to size.

### Core sections (include for all issues):
1. **Goal**
   - 1-2 sentences, measurable outcome.

2. **Context**
   - What happened / why now. Link to relevant docs/issues/PRs.

3. **Problem statement**
   - Bullet list of symptoms and observed evidence with file references.

4. **Non-goals / guardrails**
   - What must NOT regress.
   - Include key local rules from Step 0 (architecture boundaries, forbidden changes, etc.).

5. **Implementation plan (agent-ready tasks)** (Implementation issues only)
   - Numbered steps that a smaller model can execute independently.
   - Each step includes:
     - target file(s) (paths)
     - what to change
     - why
     - expected result
   - Avoid speculative refactors or "while we're here" additions.
   - If two distinct workstreams appear, split into separate issues.

6. **Validation / test plan**
   - Exact commands to run from Step 0.
   - Describe what output/behavior proves success.

7. **Acceptance criteria**
   - Checkboxes, objective and verifiable.

### Optional sections (add for larger/complex issues):
8. **Scope**
   - In scope / Out of scope.

9. **Proposed approach**
   - High-level solution in 3-6 bullets, aligned with local architecture.

10. **PR breakdown**
   - List smallest reasonable PRs (PR-1, PR-2, ...), each self-contained.

11. **Risks / rollout / rollback** (if applicable)
   - Especially for auth, billing, storage, migrations, or external integrations.
   - 2-5 bullets: risks, rollout steps, and rollback plan.

12. **Related**
   - Links to related issues, postmortems, follow-ups.

---

## Step 5: Quality Checklist

Before outputting, run a quick checklist. For small issues, focus on the core items; for large issues, aim to satisfy the full list.

- [ ] Local rules from Step 0 are reflected in guardrails, plan, validation.
- [ ] Includes explicit file paths (not just "the config file").
- [ ] Includes non-goals / guardrails.
- [ ] Includes acceptance criteria (checkboxes).
- [ ] Includes validation commands (project quality gates).
- [ ] Avoids vague language ("maybe", "probably", "should consider").
- [ ] Every plan step names target file, change, and expected result.
- [ ] Architecture boundaries respected:
  - Dependency direction matches local rules.
  - Boundary/UI must not depend on infrastructure directly.
  - Application must not depend on infrastructure directly (use ports/interfaces).
- [ ] Testing expectations are correct:
  - If changing a port/adapter/persistence schema/cross-module contract, require contract + integration tests.
  - Otherwise, smallest regression-preventing test is fine.
- [ ] No scope mixing: one cohesive change. If not, split issues.

If any item fails, revise before proceeding.

---

## Step 6: Output

### File location
- **Create mode**: `.issues/draft-<slug>.md`
- **Edit mode**: `.issues/<number>.md`

### Overwrite safety
If the target file already exists, ask before overwriting. If the user wants a new draft, append `-v2`, `-v3`, etc. to the slug.

### Write the file
Save the issue body to the target file.

### Provide the gh command

**For CREATE:**
```bash
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
gh issue create \
  --repo "$REPO" \
  --title "<title>" \
  --body-file .issues/draft-<slug>.md \
  --label "<label1>,<label2>"
```

**For EDIT:**
```bash
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
gh issue edit --repo "$REPO" <number> --body-file .issues/<number>.md
```

### Safety (MUST)
- MUST use `--body-file` for `gh issue create/edit`.
- MUST NOT pass long markdown bodies inline to `--body`.
  - Inline backticks can be interpreted by the shell and corrupt issue text.
  - `--body-file` preserves markdown exactly.

---

## Templates

Use the Small Issue Template by default. Use the Large Issue (Epic) template only when the issue is large or complex.

### Small Issue Template
```markdown
## Goal

## Context

## Problem statement

## Non-goals / guardrails

## Implementation plan

## Validation / test plan

## Acceptance criteria

## Related
```

### Large Issue (Epic) Template
```markdown
## Goal

## Context

## Problem statement

## Non-goals / guardrails

## Scope
### In scope
### Out of scope

## Proposed approach

## Implementation plan (agent-ready tasks)
### Step 1: ...
### Step 2: ...

## PR breakdown
- **PR-1**: ...
- **PR-2**: ...

## Risks / rollout / rollback

## Validation / test plan

## Acceptance criteria

## Related
```

---

## Style Guidelines

### Code citations
Reference code with `file.ts:123` plus a stable anchor (line numbers drift).

**Include both:**
- a `file:line` pointer
- and one stable anchor: symbol name OR exact grep-able string OR the search command used.

Example:
```
The bug occurs in `path/to/file.ts:105` at `someFunction()`.
Anchor: `rg "someFunction\\(" path/to/file.ts`
```

### Before/after patterns
Show before/after snippets only when they clarify the change, and adapt to local conventions (error handling, architecture, naming).

### Architecture terminology
Use the project's own terms. If the project uses hexagonal layering, use terms like: core/domain, application/use-cases, ports, adapters, infrastructure, boundary/UI.

### Acceptance criteria format
Always use checkboxes:
```markdown
- [ ] Type-check passes for affected area.
- [ ] Tests pass: `<project test command>` (and any new tests added).
- [ ] `<project quality gate command>` succeeds.
```

---

## Example Flow

```
User: /issue
Agent: [Runs Step 0, summarizes local rules/commands]
Agent: [Asks: Create or Edit?]
User: Create
Agent: [Asks: Describe the problem]
User: We need rate limiting on auth endpoints
Agent: [Researches codebase]
Agent: [Writes issue to .issues/draft-rate-limiting.md]
Agent: [Outputs gh issue create command]
```
