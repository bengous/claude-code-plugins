---
name: codex-orchestrate
description: Claude Code only. Use when the user explicitly invokes /agents-bridge:codex-orchestrate (or /codex-orchestrate) in Claude Code or asks Claude to orchestrate a large multi-slice plan by delegating implementation to the Codex CLI through agents-bridge. In native Codex, use $slice-runner instead.
---

# Orchestrating a plan in slices through Codex

Claude Code only. In native Codex, use `$slice-runner`.

## Principle

Claude is **architect, QA and committer**; Codex is **the executor**. Claude cuts
the plan into sequential slices, imposes the interfaces, starts one Codex run per
slice, checks the gates itself, and commits. Codex never commits and never
designs: if Claude lets Codex invent an API, N slices produce N styles.

## Model routing per slice

Pick the role when writing the slice's prompt:

| Slice | Role | Why |
|---|---|---|
| Standard code (features, wiring, specified refactor) | `coding` | **Default.** |
| Tests, mechanical fixes to pass a gate | `bounded` | Fastest and cheapest, enough for bounded work |
| Code that needs judgment or rigour, dense tricky points | `audit` | The highest ceiling |

`"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" models` prints the model and
effort behind each role and every effort each model supports. Hard decisions
(architecture, API choices) stay Claude's work — a slice that contains one is a
slicing defect, not a reason to move up a tier.

These models delegate well themselves: on a heavy slice, allow the prompt to
hand mechanical sub-parts to a cheaper model, rather than over-slicing on the
orchestrator's side.

**Context rule (non-negotiable)**: never read a Codex run's full event stream or
its full diff. Reading = the final message (Codex's summary) + `git diff --stat`
+ gates. Targeted inspection (grep, partial Read) only when a gate fails or the
slice has a risk named in advance in its prompt.

## Pre-flight

1. A plan the user validated, cut into slices: small, sequential, each with an
   explicit exit gate (e.g. `validate` alone for internal wiring; + e2e/visual
   for what touches the DOM).
2. **Slice 0 = baseline**: every gate green before the first slice. Otherwise,
   stop and report.
3. Branch: follow the user's instruction; by default a dedicated branch when a
   push to main triggers something. **Never push** — the user pushes.
4. First slice = the smallest and most self-contained one (a smoke test of the
   pipeline: environment, conventions, sandbox).
5. `TaskCreate` one task per slice; `TaskUpdate` as you go.
6. Insert a prerequisite slice as soon as a cross-cutting blocker shows up
   (e.g. test tooling missing for the new pattern) — never fold it into the
   current slice.

## Loop per slice

1. Write the prompt (template below) — imposed interface, semantics to preserve
   point by point.
2. Start Codex (mechanics below).
3. When it completes: its final message + `git diff --stat`. Targeted
   inspection only on the risks announced in the prompt.
4. Run the gates **yourself** (never on the faith of a "green" announced by
   Codex).
5. Commit (imperative message, repo conventions), complete the task, next slice.

## Codex prompt template

Always include, in this order:
- **Context**: stack + exemplary files to imitate ("follow the style of X"). Do
  not ask it to read CLAUDE.md/AGENTS.md: Codex loads AGENTS.md natively (and
  CLAUDE.md is often only an `@AGENTS.md` import).
- **Goal**: one sentence, with "zero behaviour change" for a refactor.
- **Imposed interface**: exact signatures (types, names, initial values), not an
  intention.
- **Tricky points**: every semantic subtlety named explicitly, with the expected
  behaviour and the suggested implementation.
- **Tests**: files, cases, naming conventions; "do not delete any existing test".
- **Forbidden**: git commit, new dependencies, files out of scope, + the repo's
  own prohibitions.
- **Documentation**: wiki/comments per the repo's conventions, "keep it minimal".
- **Definition of done**: the exact gate command, "fix until green", "do not
  run [slow suites] (I will)", "short final summary: files + non-trivial
  choices".

## Invocation mechanics

One run per slice, in its own directory. The prompt is written to a file with
the Write tool, never inline in the shell. Use the paths the commands print
literally: shell variables do not survive between Bash calls.

```bash
# 1. Create the slice's run directory; it prints <dir>:
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" new orchestrate
# 2. Write <dir>/prompt.md (Write tool — content = the slice's prompt)
# 3. Start it in write mode against the target repository:
"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" start <dir> --prompt-file <dir>/prompt.md --mode write --role coding -C /path/to/target-repo
```

- **Pin the Codex version** for the whole orchestration: the first slice's
  envelope carries `codex_version`; pass it to every later slice with
  `--codex-version <x.y.z>`. Without it, the bridge may refresh its npm
  resolution (24 h TTL) between two slices, and the version moves mid-run.
  Corrections inside a slice resume the same run, which keeps its version.
- No `--git-write`: Codex never commits, so its sandbox keeps the git
  directories read-only.
- A slice usually outlasts the call's 540 s wait: exit 10 means Codex is still
  working. The turn runs detached; collect it with
  `"${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" wait <dir>`, repeated while it
  exits 10, or start with `--wait 0` and do other work first.
- A non-git target needs `--skip-git-repo-check`.
- Corrections → write `<dir>/fix-2.md` and resume the thread (cheaper than a
  fresh context); resume replays the model, effort, mode and cwd:
  ```bash
  "${CLAUDE_PLUGIN_ROOT}/scripts/codex-run.ts" resume <dir> --prompt-file <dir>/fix-2.md
  ```

## Failure protocol

- Red gate → diagnose first: **code failure** (resume the Codex thread with the
  exact error report) or **environment failure** (files out of scope, config,
  tooling — fix it yourself, it is the orchestrator's job, not the executor's).
- Exit 11 (blocked): Codex's auto-review or its sandbox refused an action, listed
  in the envelope's `blocked`. Rule on each item as the `codex` skill's "Blocked
  actions" section says; a slice that needs an action outside its sandbox is
  often a slicing defect.
- Two failures on the same slice → stop, report to the user. Do not insist.
- Codex deviating from the spec → judge on the evidence: if the contract is
  preserved and the design defensible, accept and note it; otherwise resume with
  a correction.

## Known pitfalls (lived)

| Symptom | Cause | Fix |
|---|---|---|
| `npm E404` on the tarball, exit 1 with the npm error in `error` mid-orchestration | upstream `latest` dist-tag broken, re-resolved over the network | environment failure, not code: the bridge falls back to the last installed version on its own; `--codex-version` from the first slice avoids any re-resolution mid-run |
| Red gate on files never touched | outside pollution (installed skills, artefacts) | hygiene fix yourself (ignore files), not by Codex |
| Codex announces green, local gate red | different environments | always re-run the gates yourself |
| Slice N depends on missing tooling | cross-cutting prerequisite found late | insert a slice, never fold it in |
