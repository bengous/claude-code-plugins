Closes #470.

**Why** The hook and the CLI each parsed the plan's headings their own way, so a plan the CLI passed was denied by the hook.

**Danger** one-way door · reach: plans already approved keep their comment, but a plan the old parser let through can be denied once on its next revision.

**Start at** the contract, `scan()` in `plan-lint.ts`; read in this order: `plan-lint.ts`, `gate-plan.ts`, `plan-comment.ts`.

```diff
  gate-plan.ts
-   headingsOf(plan)            its own regex
+   scan(plan).heading          plan-lint.ts
  plan-comment.ts
-   splitSections(plan)         a third regex
+   scan(plan).heading          plan-lint.ts
```

**Proof**

| Situation | Before | After |
|---|---|---|
| `## Open questions ##`, closing hashes | CLI: open-question, hook: none | both: open-question |
| a heading inside a fence | hook: a heading | both: no heading |
| a plan with no heading | CLI and hook: no finding | the same |

**Decided**

- `scan()` stays in `plan-lint.ts` rather than a module of its own: its two readers sit beside it.
- The deny message is unchanged, so a session mid-plan sees no new text.

**Checks** `bun test --parallel github-flow/`: 212 pass, 0 fail. `bun ./scripts/gates/run-gates.ts`: 14 gates pass.

<sub>Written by Claude</sub>
