---
description: Design systems with appropriate complexity - right-sized boundaries, explicit dependencies, no premature abstraction
argument-hint: [description of the system to architect]
---

# System Architecture

Apply the system-architecture skill to design systems that match actual requirements, not imagined future needs.

## Usage

```bash
/system-architecture                        # Load the skill for current task
/system-architecture an e-commerce backend  # Apply to specific system
```

## Your Task

**Step 1: Load the skill**

Read and internalize the guidance from:
```
${CLAUDE_PLUGIN_ROOT}/skills/system-architecture/SKILL.md
```

**Step 2: Apply to context**

If `$ARGUMENTS` is provided:
- Use it as the system description
- Begin the Design Thinking process immediately
- Ask about Scale, Team, Lifespan, and Change vectors

If no arguments:
- Confirm what system the user wants to architect
- Then apply the skill's methodology

**Step 3: Follow the skill structure**

1. Answer the Design Thinking questions (Scale, Team, Lifespan, Change vectors)
2. Apply the Architecture Guidelines (Boundaries, Dependencies, Data Flow, Failure Modes, Operations)
3. Avoid the anti-patterns explicitly listed (premature distribution, abstraction theater, cargo cult, future-proofing)
4. Verify against the Success Criteria before presenting
5. Run through the complexity checklist if adding any non-trivial patterns

The skill provides the framework. Your job is to apply it with pragmatism and restraint.
