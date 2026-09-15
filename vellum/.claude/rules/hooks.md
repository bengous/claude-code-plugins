---
paths:
  - "hooks/**"
---

# The hooks module

`hooks/register.ts` is the engine adapter: one file, types from `claude-code` only, nothing
from `src/`; `$` is its one port. Held by `src/boundaries.test.ts`.

- One `State` union (`idle | drafting | reviewing | approved`), never several nullables. A
  new feature adds a variant, not a flag. Before writing `let x: T | null`, name the state
  `null` stands for.
- Parse at the boundary, once: `tool_input`, `$.store` values and the server's JSON arrive as
  `unknown` and are parsed in the block marked as the boundary parser. Past it: no `typeof`,
  no `as`, no re-check.
- Saving the file under `--plugin-dir` reloads the module in a fresh environment and every
  pending timer dies: state that must survive a reload goes to `$.store`.
- A hook answers within its dispatch's budget, about ten seconds. What waits for a person is
  polled by `$.clock.every` and handed to the session by `$.prompt.submit`, which runs once
  the session is idle.
- Tests answer `$` from memory (`register.test.ts`): `claude plugin test` cannot raise
  `classic.*` events and `bun test` cannot host the engine's environment. Nothing else is faked.
