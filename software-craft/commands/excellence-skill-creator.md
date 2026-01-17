---
description: Create design-excellence skills that push Claude toward intentional, high-quality output instead of generic patterns
argument-hint: [domain for the new skill, e.g., "API design", "error messages"]
---

# Excellence Skill Creator

Apply the excellence-skill-creator skill to create new design-excellence skills for any domain.

## Usage

```bash
/excellence-skill-creator                    # Load the skill for guidance
/excellence-skill-creator error-messages     # Create a skill for error message design
/excellence-skill-creator API design         # Create a skill for API design
```

## Your Task

**Step 1: Load the skill**

Read and internalize the guidance from:
```
${CLAUDE_PLUGIN_ROOT}/skills/excellence-skill-creator/SKILL.md
```

**Step 2: Apply to context**

If `$ARGUMENTS` is provided:
- Use it as the domain for the new skill
- Identify the "anti-slop angle" - what does generic AI output look like in this domain?
- Follow the Creation Process to build the skill

If no arguments:
- Ask what domain the user wants to create a skill for
- Help them identify the anti-slop angle
- Then proceed with skill creation

**Step 3: Follow the Creation Process**

1. Identify the domain and its anti-slop angle
2. Draft design thinking questions
3. List 3-5 key guidelines with good/bad examples
4. Name 5-10 anti-patterns Claude tends toward
5. Define 4-6 success criteria
6. Add complexity guidance
7. Write the closing principle
8. Test by using it

**Step 4: Output the skill**

Create the SKILL.md file following the structure template in the skill. Place it in the appropriate location (software-craft/skills/<domain>/).

The meta-skill provides the methodology. Your job is to extract and encode domain expertise.
