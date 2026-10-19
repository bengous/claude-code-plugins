| variant | SKILL.md | shortcuts | kind | line | end state | context out | proxy | s/case | out tokens/case | tool calls | $/run |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | before the hillclimb (88a08184) | 16/18 (89%) | 22/22 | 18/18 | 17/18 | 15/18 | 3/4 | 110 | 8781 | 6.4 | $12.42 |
| **v1** | the hillclimb's v3 | **18/18** | 22/22 | 18/18 | **18/18** | **17/18** | 3/4 | **62** | **4802** | 4.9 | **$9.20** |

A second-model check, not a climb: the hillclimb tuned SKILL.md on claude-sonnet-5-5, the user's sessions run Opus 5.5 or Fable. 22 cases × 1 rep per variant on claude-opus-5-5, noise about ±21 points, so only a large effect either way is readable.

What it shows. The additions do not hinder Opus; on every metric they hold or help. `shortcuts` 16/18 → 18/18 (the two Opus failures with the old skill, an empty test suite accepted on scratch-03 and one label on every issue on any-02, are the behaviours the Constraints clause names). `context_out` 15/18 → 17/18: with the old skill Opus put the session hook's worktree instruction and the branch to use inside the `/goal` line on feat-01, feat-02 and amb-02; the gotcha closes it; the one remaining leak is the working directory named at the top of scratch-03's line. `end_state` 17/18 → 18/18 (feat-01's "is implemented" opener is gone). `proxy` unchanged at 3/4: any-03 still writes the proxy condition without the sentence saying the task as given has no observable end state, on both models and both skills.

The side effect worth the cost of the check: Opus with v3 deliberates less. Output tokens per case 8781 → 4802, tool calls 6.4 → 4.9, latency 110 s → 62 s, cost per run $12.42 → $9.20. The longer skill text costs tokens on every call, and still the call gets cheaper: the clauses settle questions the model otherwise explored on its own.

Scores shown after the form checks learned Opus's phrasings (a blocker "named with the crate, the compiler error, and what was tried", "la conversation nomme un blocage", "N tours sont passés", a bare `<m>` in a command); every variant of both flows was re-scored with the same checks.
