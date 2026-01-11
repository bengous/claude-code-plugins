---
description: Generate comprehensive context transfer document for agent session handoffs
argument-hint: [focus-area] [--brief]
model: opus
allowed-tools:
  - Read(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - Bash(git:*)
---

# Handover Document Generator

Generate a comprehensive context transfer document that allows a fresh agent to continue this session's work. The document must be fully self-contained—the receiving agent has no access to this conversation.

## Arguments

Parse `$ARGUMENTS` for:
- **focus-area** (optional): Narrow the handover to a specific topic (e.g., "authentication", "database")
- **--brief**: Produce a shorter summary (15-25 lines instead of comprehensive)

## Step 1: Verify Current State

Before analyzing the conversation, verify the actual repository state:

```bash
git status
git log --oneline -10
git diff --stat HEAD~3..HEAD 2>/dev/null || git diff --stat
```

This grounds the handover in what actually exists, ensuring claims match committed state.

## Step 2: Analyze the Session

Reconstruct the session narrative by identifying:

1. **Initial request**: What did the user originally ask for? What problem were they trying to solve?
2. **Exploration phase**: What did we discover about the codebase? What assumptions were validated or invalidated?
3. **Decision points**: Where did the implementation fork? What alternatives were considered and why were they rejected?
4. **Implementation sequence**: What was built, in what order, and why that order?
5. **Obstacles**: What unexpected issues arose? How were they resolved?
6. **Current position**: Where did work stop? What's the immediate next action?

## Step 3: Generate Output

<brief_format>
If `--brief` flag is present, output a condensed 15-25 line summary:
- Goal (2-3 lines)
- Key decisions (bullet list)
- Current state (what's done, what remains)
- Next step

Use bullet points; omit tables and extended rationale.
</brief_format>

<full_format>
Otherwise, produce the full handover document:

```markdown
# Session Handover: [Descriptive Title]

## Original Goal

[2-4 sentences describing what the session set out to accomplish and why. Include the user's underlying motivation, not just the surface request.]

## Key Decisions

| Decision | Rationale | Alternatives Rejected |
|----------|-----------|----------------------|
| [Choice made] | [Why this approach] | [What else was considered] |

*Include 3-8 significant decisions where reasonable alternatives existed.*

## Implementation Progress

### Planned
- [What the original plan intended to accomplish]
- [Key milestones that were identified]

### Completed
- [What was actually implemented]
- [Reference specific files: `path/to/file.ts:123`]
- [Note any deviations from the original plan]

### Remaining
- [What still needs to be done]
- [In priority order if applicable]

## Challenges & Resolutions

| Challenge | How Resolved | Impact |
|-----------|--------------|--------|
| [Problem encountered] | [Solution applied] | [Effect on approach] |

*Include obstacles that affected the implementation approach.*

## Current State

### Files Modified
- `path/to/file.ts` - [Brief description of changes]
- `path/to/another.ts` - [Brief description]

### Git Status
[Current branch, uncommitted changes, recent commit summary]

### Environment/Dependencies
[Any setup, configuration, or dependencies the next agent needs to know about]

## Context for Continuation

This section captures knowledge that isn't obvious from reading the code:

- **Implicit knowledge**: Things learned during exploration
- **Gotchas**: Traps or edge cases discovered that the next agent should watch for
- **Reasoning chain**: How conclusions were reached, especially for non-obvious decisions
- **Stakeholder context**: Any user preferences or constraints mentioned during the session

## Recommended Next Steps

1. [Most immediate action with specific details]
2. [Second priority task]
3. [Third priority task if applicable]

*Be specific: "Run `npm test` to verify auth changes" rather than "Test the changes"*
```
</full_format>

## Step 4: Verify Before Output

Before presenting the handover, confirm:
- [ ] All sections have concrete content (no empty placeholders)
- [ ] File references point to files that exist (verified via git status/diff)
- [ ] Decision rationales explain *why*, not just *what*
- [ ] Next steps are specific and actionable
- [ ] No references to "this conversation" or "as discussed" (use complete references like "the auth bug in `auth.ts:45`")

## Quality Principles

**Self-contained**: Use complete references (e.g., "the authentication bug in `auth.ts:45`" rather than "the issue we saw"). The receiving agent has zero shared context.

**Decision-focused**: Emphasize *why* choices were made. A fresh agent can see *what* exists in the code; they need to understand *why* it exists to extend it correctly.

**Verifiable**: Cross-reference claims against actual git state. Confirm files exist before listing them as modified.

**Actionable**: End with concrete next steps that specify exact commands or file locations.

## Output

Present the handover document directly in the conversation for easy copy-paste to a new session.
