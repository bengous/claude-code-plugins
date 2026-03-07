# Eval Artifact Examples

Complete, copy-paste-ready examples of every JSON artifact in the eval pipeline. These are derived from real eval runs — the structures are production-tested against the eval viewer and aggregation tools.

## Table of Contents

- [evals.json](#evalsjson)
- [eval_metadata.json](#eval_metadatajson)
- [timing.json](#timingjson)
- [grading.json](#gradingjson)
- [benchmark.json](#benchmarkjson)
- [benchmark.md](#benchmarkmd)
- [Directory tree](#directory-tree)

---

## evals.json

Single source of truth for all evals. Lives at the root of the skill's eval directory.

```json
{
  "skill_name": "my-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "Convert the user dashboard from vanilla JS to a React component. It needs to fetch data from the /api/users endpoint, handle loading and error states, and preserve the existing Tailwind classes.",
      "expected_output": "A UserDashboard.tsx component with useState for loading/error/data, useEffect for fetch, proper cleanup on unmount, and preserved Tailwind class names from the original HTML.",
      "files": [
        "src/scripts/dashboard.js",
        "src/pages/index.html",
        "src/styles/main.css"
      ],
      "assertions": [
        {
          "id": "uses-usestate",
          "text": "Uses useState for loading, error, and data states (not class components or external state)"
        },
        {
          "id": "useeffect-with-cleanup",
          "text": "Uses useEffect with AbortController cleanup for the fetch call"
        },
        {
          "id": "error-boundary-or-handling",
          "text": "Handles fetch errors with try/catch and displays an error state to the user"
        },
        {
          "id": "preserves-tailwind-classes",
          "text": "Preserves existing Tailwind class names from the original HTML (not inventing new ones)"
        }
      ]
    },
    {
      "id": 2,
      "prompt": "Create a shared auth state module that tracks login status. Both the NavBar and ProfilePanel components need to read and update this state independently.",
      "expected_output": "A shared module exporting auth state with getter-based reactivity, used by both components via the same import path.",
      "files": [
        "src/pages/index.html"
      ],
      "assertions": [
        {
          "id": "shared-module-pattern",
          "text": "Uses a shared module (not prop drilling or context) for cross-component auth state"
        },
        {
          "id": "both-components-implemented",
          "text": "Provides implementation for BOTH the NavBar and ProfilePanel components"
        },
        {
          "id": "reactive-across-components",
          "text": "Updating auth state in NavBar reactively updates the display in ProfilePanel"
        }
      ]
    }
  ]
}
```

**Key rules:**
- Every eval that will be run MUST have an entry here
- `id` values must be unique integers
- `assertions[].id` uses kebab-case, `assertions[].text` is human-readable
- `files` lists project files the agent should read (relative to project root)

---

## eval_metadata.json

Per-eval file placed at the root of each eval directory. The viewer reads this locally — it does not inherit from previous iterations.

```json
{
  "eval_id": 1,
  "eval_name": "dashboard-migration",
  "prompt": "Convert the user dashboard from vanilla JS to a React component. It needs to fetch data from the /api/users endpoint, handle loading and error states, and preserve the existing Tailwind classes.",
  "assertions": [
    {
      "id": "uses-usestate",
      "text": "Uses useState for loading, error, and data states (not class components or external state)"
    },
    {
      "id": "useeffect-with-cleanup",
      "text": "Uses useEffect with AbortController cleanup for the fetch call"
    },
    {
      "id": "error-boundary-or-handling",
      "text": "Handles fetch errors with try/catch and displays an error state to the user"
    },
    {
      "id": "preserves-tailwind-classes",
      "text": "Preserves existing Tailwind class names from the original HTML (not inventing new ones)"
    }
  ]
}
```

**Key rules:**
- `eval_name` becomes the section header in the viewer
- `prompt` must match evals.json (copy it, don't retype)
- Write this file for every eval in the current iteration, even if unchanged from the previous one

---

## timing.json

Per-run file. Captured from the task notification — the ONLY source of this data.

```json
{
  "total_tokens": 108787,
  "duration_ms": 594141,
  "total_duration_seconds": 594.1
}
```

**Key rules:**
- `total_duration_seconds` = `duration_ms / 1000` (redundant but expected by some tools)
- Save immediately when the task notification arrives — this data is not persisted elsewhere

---

## grading.json

Per-run file produced by the grader agent. This is the most error-prone artifact — wrong field names cause the viewer to silently show empty results.

### Passing run example

```json
{
  "expectations": [
    {
      "text": "Uses useState for loading, error, and data states (not class components or external state)",
      "passed": true,
      "evidence": "UserDashboard.tsx lines 8-10: `const [loading, setLoading] = useState(true); const [error, setError] = useState(null); const [users, setUsers] = useState([]);`. All three state values use the useState hook. No class components or external state libraries present."
    },
    {
      "text": "Uses useEffect with AbortController cleanup for the fetch call",
      "passed": true,
      "evidence": "UserDashboard.tsx lines 12-25: `useEffect(() => { const controller = new AbortController(); fetch('/api/users', { signal: controller.signal })...; return () => controller.abort(); }, []);`. AbortController is created, passed as signal to fetch, and abort() is called in the cleanup return."
    },
    {
      "text": "Handles fetch errors with try/catch and displays an error state to the user",
      "passed": true,
      "evidence": "UserDashboard.tsx lines 14-22: try/catch wraps the fetch call. The catch block calls `setError(err.message)`. Lines 30-31: `if (error) return <div className=\"error-banner\">{error}</div>;`. Error state is both captured and rendered."
    },
    {
      "text": "Preserves existing Tailwind class names from the original HTML (not inventing new ones)",
      "passed": true,
      "evidence": "The component uses the same Tailwind classes found in the original index.html: grid grid-cols-3, rounded-lg, shadow-md, p-4, text-gray-700, bg-white, hover:bg-gray-50. All verified against the source HTML."
    }
  ],
  "summary": {
    "passed": 4,
    "failed": 0,
    "total": 4,
    "pass_rate": 1.0
  },
  "claims": [
    {
      "claim": "Component uses TypeScript (.tsx extension)",
      "type": "factual",
      "verified": true,
      "evidence": "File is named UserDashboard.tsx with typed props interface on line 3."
    }
  ],
  "eval_feedback": {
    "suggestions": [],
    "overall": "All assertions are well-targeted and discriminating. The AbortController assertion is particularly good — baseline models often skip cleanup."
  }
}
```

### Failing run example

```json
{
  "expectations": [
    {
      "text": "Uses useState for loading, error, and data states",
      "passed": true,
      "evidence": "Dashboard.jsx lines 5-7: three useState calls for loading, error, and users."
    },
    {
      "text": "Uses useEffect with AbortController cleanup for the fetch call",
      "passed": false,
      "evidence": "Dashboard.jsx lines 9-18: useEffect contains a fetch call but no AbortController. The cleanup function is an empty `return () => {};`. The fetch is not abortable on unmount."
    },
    {
      "text": "Handles fetch errors with try/catch and displays an error state to the user",
      "passed": true,
      "evidence": "Dashboard.jsx lines 11-16: try/catch around fetch, setError in catch block. Line 24: error state rendered in a div."
    },
    {
      "text": "Preserves existing Tailwind class names from the original HTML",
      "passed": false,
      "evidence": "Dashboard.jsx uses custom class names (dashboard-grid, user-card, card-title) instead of the original Tailwind utilities (grid grid-cols-3, rounded-lg, shadow-md). The original classes from index.html are not preserved."
    }
  ],
  "summary": {
    "passed": 2,
    "failed": 2,
    "total": 4,
    "pass_rate": 0.5
  },
  "claims": [
    {
      "claim": "Component is written in JavaScript, not TypeScript",
      "type": "factual",
      "verified": true,
      "evidence": "File is Dashboard.jsx, not .tsx. No type annotations present."
    }
  ],
  "eval_feedback": {
    "suggestions": [
      {
        "assertion": "preserves-tailwind-classes",
        "reason": "Consider broadening to 'preserves existing CSS class names' — the assertion should work regardless of whether the project uses Tailwind, BEM, or custom classes."
      }
    ],
    "overall": "Two failures indicate the baseline model skips cleanup patterns and tends to rename CSS classes. Both are addressable with skill guidance."
  }
}
```

**Critical field names** (the viewer reads these exact strings):

| Correct | Wrong (viewer ignores) |
|---|---|
| `expectations[].text` | `name`, `assertion`, `description` |
| `expectations[].passed` | `met`, `success`, `pass` |
| `expectations[].evidence` | `details`, `reasoning`, `explanation` |

---

## benchmark.json

Aggregated results for the entire iteration. Used by the viewer's Benchmark tab.

```json
{
  "metadata": {
    "skill_name": "my-skill",
    "executor_model": "claude-opus-4-6",
    "timestamp": "2026-03-07T12:00:00Z",
    "evals_run": [1, 2],
    "runs_per_configuration": 1
  },
  "runs": [
    {
      "eval_id": 1,
      "eval_name": "dashboard-migration",
      "configuration": "with_skill",
      "run_number": 1,
      "result": {
        "pass_rate": 1.0,
        "passed": 4,
        "failed": 0,
        "total": 4,
        "time_seconds": 594.1,
        "tokens": 108787
      },
      "expectations": [
        {"text": "Uses useState for loading, error, and data states", "passed": true, "evidence": "..."},
        {"text": "Uses useEffect with AbortController cleanup", "passed": true, "evidence": "..."},
        {"text": "Handles fetch errors with try/catch", "passed": true, "evidence": "..."},
        {"text": "Preserves existing Tailwind class names", "passed": true, "evidence": "..."}
      ]
    },
    {
      "eval_id": 1,
      "eval_name": "dashboard-migration",
      "configuration": "without_skill",
      "run_number": 1,
      "result": {
        "pass_rate": 0.5,
        "passed": 2,
        "failed": 2,
        "total": 4,
        "time_seconds": 673.5,
        "tokens": 126550
      },
      "expectations": [
        {"text": "Uses useState for loading, error, and data states", "passed": true, "evidence": "..."},
        {"text": "Uses useEffect with AbortController cleanup", "passed": false, "evidence": "..."},
        {"text": "Handles fetch errors with try/catch", "passed": true, "evidence": "..."},
        {"text": "Preserves existing Tailwind class names", "passed": false, "evidence": "..."}
      ]
    },
    {
      "eval_id": 2,
      "eval_name": "shared-auth-state",
      "configuration": "with_skill",
      "run_number": 1,
      "result": {
        "pass_rate": 1.0,
        "passed": 3,
        "failed": 0,
        "total": 3,
        "time_seconds": 234.1,
        "tokens": 43273
      },
      "expectations": [
        {"text": "Uses a shared module for cross-component auth state", "passed": true, "evidence": "..."},
        {"text": "Provides implementation for BOTH components", "passed": true, "evidence": "..."},
        {"text": "Updating auth state in NavBar reactively updates ProfilePanel", "passed": true, "evidence": "..."}
      ]
    },
    {
      "eval_id": 2,
      "eval_name": "shared-auth-state",
      "configuration": "without_skill",
      "run_number": 1,
      "result": {
        "pass_rate": 1.0,
        "passed": 3,
        "failed": 0,
        "total": 3,
        "time_seconds": 409.5,
        "tokens": 98969
      },
      "expectations": [
        {"text": "Uses a shared module for cross-component auth state", "passed": true, "evidence": "..."},
        {"text": "Provides implementation for BOTH components", "passed": true, "evidence": "..."},
        {"text": "Updating auth state in NavBar reactively updates ProfilePanel", "passed": true, "evidence": "..."}
      ]
    }
  ],
  "run_summary": {
    "with_skill": {
      "pass_rate": {"mean": 1.0, "stddev": 0.0, "min": 1.0, "max": 1.0},
      "time_seconds": {"mean": 414.1, "stddev": 254.6, "min": 234.1, "max": 594.1},
      "tokens": {"mean": 76030, "stddev": 46306, "min": 43273, "max": 108787}
    },
    "without_skill": {
      "pass_rate": {"mean": 0.75, "stddev": 0.35, "min": 0.5, "max": 1.0},
      "time_seconds": {"mean": 541.5, "stddev": 186.7, "min": 409.5, "max": 673.5},
      "tokens": {"mean": 112760, "stddev": 19490, "min": 98969, "max": 126550}
    },
    "delta": {
      "pass_rate": "+0.25",
      "time_seconds": "-127.4",
      "tokens": "-36730"
    }
  },
  "notes": [
    "with_skill achieved 100% (7/7 expectations). without_skill passed 5/7 (71%). Delta is +29%.",
    "Eval 2 (shared-auth-state) is non-discriminating: both configurations scored 100%. The model already knows shared state patterns without skill guidance.",
    "Eval 1 (dashboard-migration) is a strong discriminator: with_skill 4/4, without_skill 2/4. The baseline skipped AbortController cleanup and renamed CSS classes.",
    "The skill reduces both time (-24%) and tokens (-33%). With-skill runs proceed more directly to correct patterns."
  ]
}
```

**Critical structure rules:**
- `runs[]` ordering: put each `with_skill` run before its `without_skill` counterpart
- `configuration` must be the exact string `"with_skill"` or `"without_skill"`
- `result.pass_rate` is nested under `result` — NOT at the run top level
- `run_summary.delta` values are strings with `+`/`-` prefix

---

## benchmark.md

Human-readable summary. Must be populated with real data — not a placeholder.

````markdown
# Benchmark: my-skill (iteration 2)

**Model**: claude-opus-4-6 | **Date**: 2026-03-07 | **Evals**: 2 | **Runs per config**: 1

## Summary

| Metric | with_skill | without_skill | Delta |
|--------|-----------|---------------|-------|
| Pass rate | 100% ± 0% | 75% ± 35% | **+25%** |
| Time (s) | 414 ± 255 | 542 ± 187 | -127 (-24%) |
| Tokens | 76K ± 46K | 113K ± 19K | -37K (-33%) |

## Per-Eval Breakdown

| Eval | with_skill | without_skill | Discriminates? |
|------|-----------|---------------|----------------|
| 1. dashboard-migration | 4/4 (100%) | 2/4 (50%) | Strong |
| 2. shared-auth-state | 3/3 (100%) | 3/3 (100%) | No |

## Observations

- Eval 2 is non-discriminating — both configs score 100%. Consider replacing
  assertions with ones targeting knowledge the skill uniquely provides.
- Baseline failures cluster around cleanup patterns (AbortController) and
  preserving existing styling — exactly the gaps the skill addresses.
- The skill saves tokens and time by guiding agents directly to correct patterns.
````

---

## Directory tree

Complete reference for the expected layout:

```
.claude/evals/{skill-name}/
  evals.json
  iteration-1/
    dashboard-migration/
      eval_metadata.json
      with_skill/
        outputs/
          UserDashboard.tsx
          index.html
        transcript.jsonl
        grader-transcript.jsonl
        grading.json
        timing.json
      without_skill/
        outputs/
          Dashboard.jsx
          index.html
        transcript.jsonl
        grader-transcript.jsonl
        grading.json
        timing.json
    shared-auth-state/
      eval_metadata.json
      with_skill/
        outputs/
        transcript.jsonl
        grader-transcript.jsonl
        grading.json
        timing.json
      without_skill/
        outputs/
        transcript.jsonl
        grader-transcript.jsonl
        grading.json
        timing.json
    verification/
      compliance-check.jsonl
      mcp-validation.jsonl
    benchmark.json
    benchmark.md
    feedback.json
  iteration-2/
    (same structure, new results)
```
