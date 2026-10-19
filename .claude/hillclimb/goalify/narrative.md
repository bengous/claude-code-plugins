| round | change (one line) | shortcuts | kind | line | end state | context out | proxy | s/case | $/run | spend |
|-------|-------------------|-----------|------|------|-----------|-------------|-------|--------|-------|-------|
| 0 | baseline, SKILL.md at 88a08184 | 30/36 (83%) | 42/44 | 34/35 | 35/36 | 35/36 | 7/8 | 35 | $7.91 | 7.91 |
| v1 | proxy line complete, session instructions out of the line, the line read against the shape (3 cases × 2 reps only) | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 2/2 | - | ~$1.2 | ~9.1 |
| v2 | the Constraints clause aims at the proof as written; a shortcut-closing rule stays in the line; "not measured" is never a met state | 34/36 (94%) | 43/44 | 35/35 | 35/36 | 34/36 | 6/8 | 36 | $7.78 | ~16.9 |
| **v3** | the context gotcha names what v2 let in (environment facts, reasons, where to look) and ends on "the line explains nothing"; the "no observable end state" sentence comes before any proxy line | **34/36 (94%)** | **44/44** | 35/36 | **36/36** | **36/36** | 7/8 | 38 | $8.14 | 25.04 |

Best: v3. It ties v2 on the target and recovers both guardrails v2 had dented; on ties the later round wins. The budget ceiling of $25 is reached.

## Recommended change

SKILL.md as of v3 (the version in `goalify/skills/goalify/SKILL.md`). Versus the 2.0.0 the loop started from, three edits, each tagged:

- `[TUNE]` Constraints: the clause takes the proof as written and asks what the cheapest action is that would make its line print without the work; names the recurring forms (one answer applied to every item, a substitute for the named tool, a generated file written by hand, a declaration checked where the thing should be exercised, the hard question left "not measured"); closes each in the line; a fact the task exists to establish is never met by "unknown". (v2)
- `[TUNE]` Gotchas: environment facts, the reason a check is left out, and where to look are worker context; the rule that closes a shortcut is the one thing that must stay in the line; the line explains nothing. (v2, tightened in v3)
- `[TUNE]` Output: the "no observable end state" sentence comes before any proxy line; a proxy line is complete, with no placeholder. (v1, v3)

## Versus baseline

22 cases × 2 reps, no split, directional. `shortcuts` 30/36 → 34/36 (+11 points, at the edge of the ±15 noise floor); `kind_ok` 42/44 → 44/44; `end_state` 35/36 → 36/36; `proof_line` 35/36 → 36/36; `context_out` 35/36 → 36/36; `line_ok` 34/35 → 35/36; `proxy` 7/8 → 7/8. Cost per run $7.91 → $8.14, latency 35 s → 38 s per case: the line got longer by the constraints it now carries.

## Why trust this

- The mechanism is visible in the transcripts, not only in the score. any-02 rep0 at baseline proved the triage by a count that one label on every issue would satisfy; at v3 the proof prints one line per issue with its single type label (`baseline/traces/any-02_rep0.json`, `v3/traces/any-02_rep0.json`). scratch-05 rep1 at baseline proved three MCP servers by a "✔ Connected" health line; at v3 each server must have served a real call whose output is printed, context7 returning a library id, playwright a page title, github the login (`baseline/traces/scratch-05_rep1.json`, `v3/traces/scratch-05_rep1.json`).
- Every variant was scored by the same checks and the same judge; the form checks were corrected during the loop to read goalify's own phrasing (French clauses, the passive "est nommé" whatever introduces it, "stoppe") and every variant was re-scored from its traces.
- The gain is at the noise floor's edge, with no held-out set. It is a directional result: two reps agree on the recovered rows, and the recovered behaviour is the one the change describes.

## What else was tried

Nothing was reverted. v1 was a targeted re-run of three cases, not a round. The two `shortcuts` rows still failing at v3 (deps-01 rep0, deps-04 rep1) share one behaviour the judge names: the condition forbids the generic bypasses but never requires the repository's own gates in the proof. One form failure appeared at v3 (feat-01 rep1): the condition continued below the `/goal` line as a list of five outputs, so the line alone has no blocker clause and no cap.

## What to try next

- A rule that the proof names the repository's own gate command when the repository has one (`AGENTS.md`, `package.json` scripts, CI), which the two remaining `shortcuts` rows and the v1-era deps-01 rep1 all miss.
- A rule that the condition never continues below its line: a list after the line is read by nobody but the worker.
- Reps or cases: at 22 × 2 the floor is ±15 points; the next climb needs ±8 or better to see a one-row change, so 4 reps or 50 cases.
- The real oracle: run a sample of conditions through `/goal` itself and count evaluator turns to the verdict, which this eval approximates with a judge.
