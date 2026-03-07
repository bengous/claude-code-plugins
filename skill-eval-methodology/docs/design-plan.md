# Create Skill Eval Methodology Guide

## Context

After running 2 iterations of evals on the `svelte-astro-integration` skill, several operational problems emerged that are **not covered** by the skill-creator plugin's documentation. The skill-creator covers the mechanics (JSON schemas, grading instructions, aggregation scripts, viewer usage). What's missing is operational discipline — checklists that prevent data loss, stale artifacts, and wasted iterations.

**Problems encountered** (all preventable with a guide):
1. Transcripts lost in `/tmp/` — not copied to eval directories
2. evals.json out of sync — only 4 of 7 evals tracked
3. Aggregation script failed on descriptive directory names
4. Factually wrong assertion burned an entire iteration
5. Non-discriminating evals (3 of 7 scored 100% both with and without skill)
6. Contradicting guardrails in SKILL.md after adding new content
7. benchmark.md left as unpopulated placeholder
8. Verification transcripts from iteration-1 not saved

**Goal**: Create a companion skill that auto-loads alongside skill-creator, providing operational checklists for the eval lifecycle.

## Implementation

### Task 1: Create the skill directory and SKILL.md

**File**: `~/.claude/skills/skill-eval-methodology/SKILL.md`

Create a proper skill with YAML frontmatter and a description that triggers alongside skill-creator during eval work. The body contains lifecycle-organized checklists:

1. **Before Starting** — pre-flight checklist (commit edits, verify evals.json completeness, MCP-validate assertions, check for non-discriminating evals, grep for guardrail contradictions, run verification agents)
2. **Directory Structure Standard** — the canonical layout with all required files per run
3. **During Execution** — transcript preservation (copy from `/tmp/` immediately), timing capture, eval_metadata.json sync
4. **After All Runs** — grading field requirements (`text`/`passed`/`evidence`, not `name`/`met`/`details`), benchmark.json critical fields, benchmark.md must be populated, evals.json reconciliation
5. **Iteration Boundary** — checklist before starting N+1
6. **Eval Quality Signals** — non-discriminating eval detection table, assertion anti-patterns
7. **Quick Reference** — critical JSON field names the viewer/aggregator expect

Content is under 280 lines. Complements (does not duplicate) skill-creator's 480-line SKILL.md and schemas.md.

<details>
<summary>Full SKILL.md content</summary>

```yaml
---
name: skill-eval-methodology
description: Operational discipline for running skill evaluations with /skill-creator. Use this whenever running evals, benchmarks, or iterations on a skill — phrases like "run evals", "benchmark the skill", "iterate on evals", "grade the runs", "start iteration 2", or any work involving evals.json, benchmark.json, grading.json, or the eval-viewer. Provides checklists that prevent common data-loss and consistency errors.
---

# Skill Eval Methodology

Operational checklists for running skill evals. Skill-creator covers the mechanics; this covers the discipline that prevents data loss, stale artifacts, and wasted iterations.

## Before Starting an Eval Iteration

### Pre-flight Checklist

- [ ] **Commit skill edits.** `git add` the skill files and commit before spawning eval agents. The commit hash is the reproducible pointer to the exact skill state tested.
- [ ] **evals.json is complete.** Every eval has an entry in `evals.json` with `id`, `prompt`, `expected_output`, `files`, and `assertions`. Verify: `jq '.evals | length' evals.json` matches the number of eval directories you plan to create.
- [ ] **Assertions are factually correct.** For each assertion, verify the claim against actual framework behavior using MCP tools or official docs. A wrong assertion wastes an entire iteration.
- [ ] **Assertions discriminate.** Ask: "Would a capable model pass this WITHOUT the skill?" If yes for most assertions, the eval won't measure skill value. At least 2 assertions per eval should target knowledge the skill uniquely provides.
- [ ] **Guardrails are consistent.** If the skill has numbered guardrails, read them sequentially and check for contradictions. Adding guardrail N must not conflict with guardrails 1 through N-1.
- [ ] **Run verification agents.** Before the full suite, spawn a verification agent to check: (1) assertions match skill claims, (2) no internal contradictions, (3) MCP-validate API-specific assertions.

### Directory Structure Standard

```
.claude/evals/{skill-name}/
  evals.json                          # Single source of truth for all evals
  iteration-{N}/
    {descriptive-eval-name}/          # e.g., timeline-migration, cross-island-comm
      eval_metadata.json              # Prompt + assertions for THIS eval
      with_skill/
        outputs/                      # Agent output files
        transcript.jsonl              # Agent conversation transcript
        grader-transcript.jsonl       # Grader agent transcript
        grading.json                  # Graded assertions
        timing.json                   # Tokens + duration from task notification
      without_skill/
        (same structure)
    verification/                     # Pre-run and post-run verification transcripts
    benchmark.json                    # Aggregated quantitative results
    benchmark.md                      # Human-readable summary (MUST be populated)
    feedback.json                     # Viewer feedback from human review
```

Use descriptive directory names. The viewer discovers runs by finding `outputs/` directories recursively — it does not depend on `eval-0/` naming.

## During Eval Execution

### Transcript Preservation

Agent transcripts live in `/tmp/claude-*/tasks/{agentId}.output` and are **ephemeral**. They will be lost on reboot or cleanup.

**Immediately after each agent completes**, copy the transcript:
```bash
cp /tmp/claude-*/tasks/{agentId}.output \
  {eval-dir}/{config}/transcript.jsonl
```
Do the same for grader and verification agent transcripts. Do not defer. Do not batch. Copy as each task notification arrives.

### Timing Data Capture

Task notifications contain `total_tokens` and `duration_ms` — the ONLY source of this data. Save immediately:

```json
{
  "total_tokens": 84852,
  "duration_ms": 382800,
  "total_duration_seconds": 382.8
}
```

### eval_metadata.json Sync

Write `eval_metadata.json` for every eval directory in the current iteration, even if the prompt is unchanged. The viewer reads this file locally — it does not inherit from previous iterations.

```json
{
  "eval_id": 1,
  "eval_name": "timeline-migration",
  "prompt": "...",
  "assertions": [
    {"id": "short-kebab-id", "text": "Human-readable assertion text"}
  ]
}
```

## After All Runs Complete

### Grading

The viewer requires these exact field names in grading.json:

```json
{
  "expectations": [
    {
      "text": "Assertion text (must match evals.json)",
      "passed": true,
      "evidence": "Specific quote or file reference"
    }
  ],
  "summary": {"passed": 6, "failed": 2, "total": 8, "pass_rate": 0.75}
}
```

**Not** `name`/`met`/`details` or any variant. Wrong field names cause the viewer to silently show empty results.

### Benchmark Aggregation

If `aggregate_benchmark.py` fails (common with descriptive directory names), build `benchmark.json` manually. Critical viewer fields:

| File | Field | Requirement |
|---|---|---|
| benchmark.json | `runs[].configuration` | Exact string `"with_skill"` or `"without_skill"` |
| benchmark.json | `runs[].result.pass_rate` | Nested under `result`, not at run top level |
| benchmark.json | `runs[].eval_name` | Used as section header in viewer |
| benchmark.json | `run_summary.{config}.pass_rate.mean` | Used in summary table |
| grading.json | `expectations[].text` | Not `name` |
| grading.json | `expectations[].passed` | Not `met` |
| grading.json | `expectations[].evidence` | Not `details` |

### benchmark.md

Populate with actual data. A template with zero values signals incomplete work and misleads future iterations. Include: model name, date, summary table (pass rate / time / tokens / delta), per-eval breakdown, analyst observations.

### evals.json Reconciliation

After grading, verify evals.json tracks ALL evals that were run. Count eval directories and compare to `jq '.evals | length' evals.json`. Add any missing entries.

## Iteration Boundary Checklist

Before starting iteration N+1:

- [ ] All transcripts saved (agent + grader + verification)
- [ ] benchmark.json and benchmark.md populated with real data
- [ ] evals.json contains all evals from iteration N
- [ ] feedback.json read and incorporated
- [ ] Skill edits for N+1 committed
- [ ] Changed assertions re-verified against framework docs
- [ ] Changed guardrails checked for contradictions

## Eval Quality Signals

### Non-Discriminating Eval Detection

| Pattern | Diagnosis | Action |
|---|---|---|
| Both configs 100% | Tests baseline model knowledge | Replace assertions with skill-specific ones |
| Both configs ~same | Does not measure skill value | Redesign prompt to target skill's unique contributions |
| with_skill > without_skill by 20%+ | Strong discriminator | Keep |
| with_skill < without_skill | Skill may be hurting | Investigate — skill might give wrong guidance |

### Assertion Anti-Patterns

- **Trivially satisfied**: "Uses modern syntax" — models default to this
- **Unfalsifiable**: "Code is well-structured" — no objective criteria
- **Factually wrong**: Contradicts official docs (MCP-validate before running)
- **Overly prescriptive**: Fails valid alternatives the assertion didn't anticipate
```

</details>

### Task 2: Add pointer in global CLAUDE.md

**File**: `~/.claude/CLAUDE.md`

Add after the "Tool Preferences" section (line 80):

```markdown

## Skill Evaluation

When running skill evals via `/skill-creator`, the `skill-eval-methodology` skill provides operational checklists. It auto-loads based on context, or invoke it manually if needed.
```

This is 2 lines — minimal CLAUDE.md growth.

## Verification

1. Confirm `~/.claude/skills/skill-eval-methodology/SKILL.md` exists and has valid YAML frontmatter
2. Confirm Claude discovers the skill: in a new conversation, check if `skill-eval-methodology` appears when discussing skill evals
3. Confirm the CLAUDE.md pointer is present
4. Read the final SKILL.md end-to-end for coherence — no stale references to the svelte project (guide must be fully generic)

## Design Decisions

**Why a global skill, not a CLAUDE.md section**: The checklists are ~270 lines. Embedding them in CLAUDE.md (currently 81 lines) would triple its size and load eval-specific content on every conversation. A skill triggers only when relevant.

**Why not a reference file under skill-creator**: The user doesn't control the plugin cache — modifications are overwritten on updates. `~/.claude/skills/` is user-controlled.

**Why not split into multiple reference files**: The content is a single linear lifecycle under 280 lines. Splitting adds progressive-loading overhead for no benefit.

**Why descriptive directory names in the standard**: `timeline-migration` is immediately scannable vs `eval-0`. The viewer discovers runs by `outputs/` presence, not naming. The tradeoff: `aggregate_benchmark.py` may not find them, but building benchmark.json manually is documented as the fallback.
