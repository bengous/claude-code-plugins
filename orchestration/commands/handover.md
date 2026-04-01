---
description: Generate comprehensive context transfer document for agent session handoffs
argument-hint: "[focus-area] [--brief]"
model: opus
allowed-tools:
  - Read(*:*)
  - Grep(*:*)
  - Glob(*:*)
  - Bash(git:*)
---

# Handover Document Generator

Generate a self-contained context transfer document that allows a fresh agent to continue this session's work. The receiving agent has no access to this conversation — every reference must be complete and verifiable.

## Arguments

Parse `$ARGUMENTS` for:
- **focus-area** (optional): Narrow the handover to a specific topic (e.g., "authentication", "database")
- **--brief**: Produce a shorter summary (15-25 lines instead of comprehensive)

## Step 1: Ground Truth

Verify actual repository state before analyzing the conversation:

```bash
git status
git log --oneline -10
git diff --stat HEAD~3..HEAD 2>/dev/null || git diff --stat
```

Reflect on whether the git state matches your session memory. Note any discrepancies — they indicate uncommitted work, reverted changes, or stale assumptions.

## Step 2: Reconstruct the Session

Analyze the conversation to capture: the original goal and underlying motivation, key decisions with rationale and rejected alternatives, implementation sequence and obstacles encountered, implicit knowledge and gotchas discovered, and where work stopped.

Focus on the WHY behind decisions — a fresh agent can read the code to see WHAT exists, but needs the handover to understand WHY it exists.

<brief>
If `--brief` flag is present, output a 15-25 line summary using bullet points:
- Goal (2-3 lines)
- Key decisions (bullet list)
- Current state (done / remaining)
- Immediate next step
</brief>

<full>
Otherwise, produce a comprehensive document with these sections. Adapt the format to fit the session — omit sections that have no meaningful content, use tables only when comparing multiple items:

- **Original Goal**: What the session set out to accomplish and the underlying motivation (2-4 sentences)
- **Key Decisions**: Significant choices where alternatives existed, with rationale and what was rejected
- **Progress**: What was planned, what was completed (with file references like `path/file.ts:123`), what remains
- **Challenges**: Obstacles that affected the approach and how they were resolved
- **Current State**: Modified files, git status, branch, uncommitted changes, environment/dependencies
- **Context for Continuation**: Implicit knowledge, gotchas, reasoning chains, and user preferences that aren't obvious from the code
- **Next Steps**: Numbered, specific, actionable (e.g., "Run `bun test` to verify auth changes" rather than "Test the changes")
</full>

## Principles

Apply these throughout the document:

- **Self-contained**: Use complete references (e.g., "the auth bug in `auth.ts:45`") so the document stands alone without conversation context
- **Decision-focused**: Explain WHY choices were made — the receiving agent can discover WHAT exists by reading the code
- **Grounded**: Cross-check every file reference and claim against the git state verified in Step 1

## Output

Present the handover document directly in the conversation for easy copy-paste to a new session.
