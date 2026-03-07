---
name: skill-eval-methodology
description: Operational discipline for running skill evaluations with /skill-creator. Use this whenever running evals, benchmarks, or iterations on a skill — phrases like "run evals", "benchmark the skill", "iterate on evals", "grade the runs", "start iteration 2", or any work involving evals.json, benchmark.json, grading.json, or the eval-viewer. Provides checklists that prevent common data-loss and consistency errors.
---

# Skill Eval Methodology

Operational checklists for running skill evals. Skill-creator covers the mechanics; this covers the discipline that prevents data loss, stale artifacts, and wasted iterations.

## Reference

For complete, copy-paste-ready examples of every JSON artifact (evals.json, eval_metadata.json, grading.json, timing.json, benchmark.json, benchmark.md), read @references/artifact-examples.md. Use it when creating artifacts from scratch or when unsure about exact field names or structure.

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

### Launching the Eval Viewer

If the project has a local viewer at `.claude/evals/viewer/generate_review.py`, prefer it — it may have project-specific patches. Otherwise use the skill-creator's bundled viewer.

```bash
VIEWER=.claude/evals/viewer/generate_review.py   # local, or:
VIEWER=/path/to/skill-creator/eval-viewer/generate_review.py  # bundled

# Server mode (auto-opens browser, feedback auto-saves)
python $VIEWER .claude/evals/{skill}/iteration-{N} \
  --skill-name "{skill}" \
  --benchmark .claude/evals/{skill}/iteration-{N}/benchmark.json

# With previous iteration comparison (iteration 2+)
python $VIEWER .claude/evals/{skill}/iteration-{N} \
  --skill-name "{skill}" \
  --benchmark .claude/evals/{skill}/iteration-{N}/benchmark.json \
  --previous-workspace .claude/evals/{skill}/iteration-{N-1}

# Static HTML (headless environments, no server)
python $VIEWER .claude/evals/{skill}/iteration-{N} \
  --static /tmp/{skill}-review.html
```

The viewer discovers runs by finding `outputs/` directories recursively. It reads `eval_metadata.json` for prompts, `grading.json` for formal grades, and `benchmark.json` for the Benchmark tab. Missing files are silently skipped — the viewer still works with partial data.

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
