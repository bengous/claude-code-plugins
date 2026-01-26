---
description: Review skills against official skill-creator guidelines using multi-agent consensus
argument-hint: <skill-path>
allowed-tools:
  - Read
  - Glob
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/quick_validate.py":*)
  - Bash(ls:*)
  - Bash(wc:*)
  - Task
  - AskUserQuestion
model: claude-opus-4-5
---

# Skill Review

Review a skill against the official skill-creator guidelines using multi-agent consensus evaluation.

## Input

**$ARGUMENTS** - Path to the skill directory to review

## Step 1: Load Guidelines

Read the authoritative skill-creator guidelines:
`${CLAUDE_PLUGIN_ROOT}/skills/skill-creator/SKILL.md`

Extract and remember the key criteria for evaluation.

## Step 2: Structural Validation

Run the structural validation script:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/quick_validate.py" "$ARGUMENTS"
```

Capture pass/fail status and any error messages.

## Step 3: Read Target Skill

1. Read `$ARGUMENTS/SKILL.md`
2. Run `ls -la "$ARGUMENTS"` to see all files
3. Run `wc -l "$ARGUMENTS/SKILL.md"` to get line count
4. If references/, scripts/, or assets/ exist, list their contents

## Step 4: Multi-Agent Evaluation

Launch 3 parallel Task agents with `subagent_type: "Explore"`. Each evaluates from a different perspective.

**CRITICAL**: Paste actual content into each agent prompt. Do NOT give file paths and expect agents to read them - this causes agents to evaluate wrong files. Include:
- The relevant skill-creator guidelines sections (pasted, not referenced)
- The target skill's SKILL.md content (pasted in full or excerpted as needed)
- The directory listing (pasted)

### Agent 1: Structure & Organization

Prompt must include ACTUAL CONTENT (not file paths):

```
You are evaluating a skill against the official skill-creator guidelines.

FOCUS ONLY ON:
1. File organization - Does it have SKILL.md? Are scripts/, references/, assets/ properly used?
2. No extraneous files - Are there README.md, CHANGELOG.md, or other junk files?
3. Reference depth - Are references one level deep from SKILL.md (not nested)?
4. Directory naming conventions - Proper structure?

GUIDELINES (excerpt):
[PASTE the "Anatomy of a Skill" and "What to Not Include" sections from skill-creator SKILL.md]

TARGET SKILL NAME: <name>

TARGET SKILL DIRECTORY LISTING:
[PASTE ls -la output here]

TARGET SKILL.md CONTENT:
[PASTE full SKILL.md content here]

For each criterion, rate: PASS / WARN / FAIL
Include brief justification for each rating.
Format as a simple numbered list.
```

### Agent 2: Description & Frontmatter

Prompt must include ACTUAL CONTENT (not file paths):

```
You are evaluating a skill against the official skill-creator guidelines.

FOCUS ONLY ON:
1. Name format - Is it hyphen-case? Max 64 chars? No leading/trailing hyphens?
2. Description quality - Is it specific? Does it include trigger phrases/contexts?
3. Selection quality - Would Claude pick this skill from 100+ options based on description?
4. Allowed fields only - Only name, description, license, allowed-tools, metadata?

GUIDELINES (excerpt):
[PASTE the "Frontmatter" section from skill-creator SKILL.md]

TARGET SKILL NAME: <name>

TARGET SKILL.md FRONTMATTER AND FIRST 50 LINES:
[PASTE the frontmatter and first 50 lines here]

For each criterion, rate: PASS / WARN / FAIL
Include brief justification for each rating.
Format as a simple numbered list.
```

### Agent 3: Content & Efficiency

Prompt must include ACTUAL CONTENT (not file paths):

```
You are evaluating a skill against the official skill-creator guidelines.

FOCUS ONLY ON:
1. Body conciseness - Is it under 500 lines? (Current: X lines)
2. Token efficiency - Is content minimal? Does each section justify its token cost?
3. Progressive disclosure - Is content split well between SKILL.md and references?
4. Degrees of freedom - Is specificity appropriate for task fragility?
5. Writing style - Uses imperative/infinitive form?

GUIDELINES (excerpt):
[PASTE "Concise is Key", "Progressive Disclosure", and "Set Appropriate Degrees of Freedom" sections from skill-creator SKILL.md]

TARGET SKILL NAME: <name>

TARGET SKILL.md FULL CONTENT:
[PASTE full SKILL.md content here]

LINE COUNT: X lines

For each criterion, rate: PASS / WARN / FAIL
Include brief justification for each rating.
Format as a simple numbered list.
```

## Step 5: Merge Consensus

Collect all three agent responses. For each criterion that appears:
- **3/3 agree** → Use that rating directly
- **2/3 agree** → Use majority, note the dissent
- **All disagree** → Mark as UNCERTAIN, show all perspectives

## Step 6: Present Results

Format the output as:

```
## Skill Review: <skill-name>

### Structural Validation
<quick_validate.py output>

### Multi-Agent Quality Assessment

| Category | Score | Consensus | Notes |
|----------|-------|-----------|-------|
| File Organization | ✅/⚠️/❌ | X/3 | ... |
| No Extraneous Files | ✅/⚠️/❌ | X/3 | ... |
| Reference Depth | ✅/⚠️/❌ | X/3 | ... |
| Name Format | ✅/⚠️/❌ | X/3 | ... |
| Description Quality | ✅/⚠️/❌ | X/3 | ... |
| Selection Quality | ✅/⚠️/❌ | X/3 | ... |
| Body Conciseness | ✅/⚠️/❌ | X/3 | ... |
| Token Efficiency | ✅/⚠️/❌ | X/3 | ... |
| Progressive Disclosure | ✅/⚠️/❌ | X/3 | ... |
| Degrees of Freedom | ✅/⚠️/❌ | X/3 | ... |
| Writing Style | ✅/⚠️/❌ | X/3 | ... |

### Priority Issues
[List FAIL items first, then WARN items, with specific fixes]

### Recommendations
[Actionable improvements based on agent feedback]
```

## Step 7: Offer Improvements

Use `AskUserQuestion`:
- Question: "Would you like specific edit suggestions for the identified issues?"
- Options: "Yes, show edits" / "No thanks"

If yes, provide concrete text edits for the priority issues.
