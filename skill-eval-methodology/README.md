# Skill Eval Methodology Plugin

Operational discipline for running skill evaluations with `/skill-creator`. Provides lifecycle checklists that prevent data loss, stale artifacts, and wasted iterations.

## Skills

### `skill-eval-methodology`

Auto-triggers when working with skill evaluations — running evals, benchmarking, grading, or iterating on skills.

**What it covers:**

- **Pre-flight checklist** — commit edits, verify evals.json completeness, MCP-validate assertions, check for non-discriminating evals, guardrail contradiction checks
- **Directory structure standard** — canonical layout for eval artifacts with descriptive names
- **Transcript preservation** — copy agent transcripts from `/tmp/` before they're lost
- **Grading field requirements** — exact JSON field names the viewer expects (`text`/`passed`/`evidence`, not `name`/`met`/`details`)
- **Benchmark aggregation** — critical viewer fields and manual fallback when `aggregate_benchmark.py` fails
- **Iteration boundary checklist** — what to verify before starting the next iteration
- **Eval quality signals** — detecting non-discriminating evals and assertion anti-patterns

## Why This Exists

The `/skill-creator` plugin covers the mechanics of running evals (JSON schemas, grading instructions, aggregation scripts). This plugin covers the **operational discipline** — the checklist that prevents common mistakes discovered through real eval iterations:

1. Transcripts lost in `/tmp/` — not copied to eval directories
2. `evals.json` out of sync with actual eval directories
3. Aggregation script failing on descriptive directory names
4. Factually wrong assertions wasting entire iterations
5. Non-discriminating evals (100% pass rate with and without skill)
6. Contradicting guardrails after adding new skill content
7. `benchmark.md` left as unpopulated placeholder

## Installation

This plugin is part of the `bengous-plugins` marketplace.

Add to `.claude/settings.json`:
```json
{
  "enabledPlugins": ["skill-eval-methodology@bengous-plugins"]
}
```

Or install via command:
```bash
/plugin install skill-eval-methodology@bengous-plugins
```

## License

MIT
