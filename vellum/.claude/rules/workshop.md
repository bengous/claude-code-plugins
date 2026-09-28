---
paths:
  - "src/workshop/**"
---

# The workshop

`src/workshop/` is the pure core the three runtimes read: pure functions over immutable data, no
`node:*`, no `bun`, and no import outside itself, not even a type (`src/boundaries.spec.ts`): it
names the listeners and the page slots the runtimes then type. A slice's machinery (`plugs.ts`, `rows.ts`, `waits.ts`) is
`slices.md`'s; how the server applies what is decided here is `server.md`'s.

- `next` in `workflow.ts` judges an event against one table, the review's rows and each slice's,
  and answers the next workflow with its effects; it reads no clock, no file, and mints no id, so
  a route reads those first and hands them in the event's input.
- State is derived, never stored twice: where the review stands is `workspaceOf`
  (`workspace.ts`), off the directory's listing and the server's memory. A new feature adds a
  variant to a union, not a flag.
- A brand is minted by its parser alone: `parseWipDir`, `parseVersion`, `parseProjectPath`
  (`paths.ts`) grant `WipDir`, `Version`, `ProjectPath`, and answer a `ParseResult` where the caller
  decides.
- A new domain concept gets its address here before its first line.
