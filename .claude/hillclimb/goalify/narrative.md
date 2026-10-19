| round | change (one line) | shortcuts | kind | line | context out | proxy | s/case | $/run | spend |
|-------|-------------------|-----------|------|------|-------------|-------|--------|-------|-------|
| 0 | baseline, SKILL.md at 88a08184 | 30/36 (83%) | 42/44 | 34/35 | 35/36 | 7/8 | 35 | $7.91 | 7.91 |
| v1 | proxy line complete, session instructions out of the line, the line read against the shape (3 cases × 2 reps only) | 6/6 | 6/6 | 6/6 | 6/6 | 2/2 | - | ~$1.2 | ~9.1 |
| v2 | the Constraints clause aims at the proof as written; a shortcut-closing rule stays in the line; "not measured" is never a met state | **34/36 (94%)** | 43/44 | 35/35 | 34/36 | 6/8 | 36 | $7.78 | ~16.9 |

Best so far: v2 (shortcuts +4 rows, +11 points, at the edge of the ±15 noise floor; every form metric at 100%). Guardrails moved within noise, in the direction the round predicted: `context_out` lost one row (environment facts pulled into the line, amb-02 rep1, feat-05 rep0 versus feat-02 rep0 at baseline) and `proxy` lost one (any-03: the judge wants the sentence "no observable end state" before the proxy condition; the skill wrote the proxy without saying it).

Goal: raise `shortcuts`, the judge's verdict that the constraints close the shortest path to the end state that is not the work; every other metric must hold. No split: 22 cases scored every round, directional, noise about ±15 points. Scores shown after the form checks were corrected to read goalify's own phrasing (French clauses, a passive "est nommé" whatever introduces it, "stoppe"); every variant was re-scored from its traces with the same checks, so the columns compare like with like.

Where the loop stands: the remaining `shortcuts` zeros are two rows (deps-01 rep0: the proof does not require the repo gates; any-02 rep0: the per-issue evidence is still missing), below what the eval can resolve in one more round. The levers with headroom are now `context_out` (the v2 carve-out lets environment facts into the line) and `proxy` (the acknowledgement sentence before a proxy condition).
