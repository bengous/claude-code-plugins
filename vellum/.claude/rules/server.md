---
paths:
  - "src/**"
---

# The server

Hexagonal with a functional core. `src/domain/` is pure functions over immutable data: no
`node:*`, no `bun`, no adapter, app or page import. `src/app/review.ts` is the one use case:
read through the adapter, decide in the domain, apply files, memory and listeners.
`src/adapters/` are plain modules, no interface, no injection: `fs.ts` every read and write
under the project root, `http/routes.ts` bodies, paths and status codes, `http/serve.ts`
binding and the page bundle, `browser.ts` the opener. Direction held by `boundaries.test.ts`.

- Decide, then apply. Read everything first, take the decision as a pure function of plain
  values in `domain/`, then write files, timers and prompts through `adapters/`.
- State is derived, never stored twice: what is pending comes from the workspace
  (`domain/workspace.ts`, `pendingOf`), not from a second variable. A new feature adds a
  variant to a union, not a flag.
- Parse at the boundary, once, into a branded type: `parseWipDir`, `parseVersion`,
  `parseProjectPath` grant `WipDir`, `Version`, `ProjectPath`. Past the parser: no `typeof`,
  no `as`, no re-check. A `ParseResult` is returned where the caller decides; anything else
  throws, and the route turns it into an answer.
- `protocol.ts` is the one place a value crossing HTTP or a plugin boundary is typed; it
  re-exports the domain types it carries, never redefines them.
- A new domain concept gets its address in `domain/` before its first line.
