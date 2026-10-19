# Metrics

Form checks, computed by `goalify/evals/grade.ts` on the `/goal` line (French or English):

- `kind_ok`: a condition case has exactly one `/goal` line; a refusal case has none, or one written on a proxy with no placeholder.
- `line_ok`: the line is under 4000 characters, unfenced, unlabelled, and has a proof command, a blocker clause joined by "or", and a cap.
- `proof_cmd`, `blocker_or`, `cap`: the three parts of `line_ok`, separately.

Judge, `claude-opus-5-5` through `claude -p --json-schema`, one boolean and one reason per property, from the output alone:

- `end_state`: a fact in the present tense, not an activity or an order.
- `proof_line`: the command and the output line that shows the end state; an echoed exit code fails.
- `shortcuts`: the constraints close the shortest path to the end state that is not the work, as the case hints describe it. **Target of the hillclimb.**
- `context_out`: no worker-only context inside the line.
- `proxy` (refusal cases): the response says no end state is observable and offers a proxy, a Stop hook, writes the proxy as the condition, or asks for the delta.

Perf: `cost_usd` derived from `model` × `usage` and `judge_model` × `judge_usage` at first-party prices; `latency_s` of the skill's call; `tool_calls` and `num_turns` of the skill's session.

Noise: 22 cases × 2 reps, no split, about ±15 points on a rate. Round scores are directional.
