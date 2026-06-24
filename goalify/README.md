# goalify

Convert rough intent into the smallest useful goal payload to hand to a fresh
Claude Code agent.

**Version:** 1.0.0

Ported from the Codex CLI `goalify` skill. goalify produces goal *text*; it does
not run the downstream work.

## Invoke

```
/goalify:goalify <rough intent or draft>
```

(The short `/goalify` usually resolves too.)

## Modes

- **Draft-first (default)** — `/goalify <intent>`. Infers reasonable details and
  asks only when a missing detail materially changes scope, risk, or acceptance
  criteria.
- **Interactive (question-first)** — `/goalify interactive <idea>`. Asks one
  decision at a time (via AskUserQuestion, recommended option first) before
  writing the goal.

## Output

- **≤ 4000 chars:** the raw goal payload, ready to copy.
- **> 4000 chars:** written to `.agents/goals/<slug>.md`; the path is printed
  with how to hand it to a new session, a subagent, or `/loop`.

The payload uses a compact shape:

```text
<objective sentence>
Context:
Constraints:
Success means:
Validate with:
Stop when:
Pause if:
```

Only the sections that carry real information are included.

## Differences from the Codex original

The `/goal` primitive and the `codex-goal` sudo/immutable-file helper are
adapted out for the Claude Code permission model. See
[`skills/goalify/references/design-notes.md`](skills/goalify/references/design-notes.md).

## Install

Registered in this repo's `marketplace.json` as `goalify` (`source: ./goalify`).
After syncing, restart Claude Code.
