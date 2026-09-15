# Architecture

## Layers

```
hooks/register.ts      the hooks module: one file, imports types only, talks to the engine through `$`
        │ HTTP, token header
src/server/routes.ts   the boundary: parses bodies and paths, answers status codes, nothing else
src/server/review.ts   reads the directory, calls transitions.ts, applies: files, memory, listeners
src/server/transitions.ts   the decisions, pure functions of plain values
src/workspace/*        branded paths, versions, slug, rename, link rewrite; parsers and file operations
src/feedback/*         the text Claude reads
src/protocol.ts        the types both sides of HTTP share; everything in it is JSON
ui/*, plugins/*/ui.tsx the page (Preact + signals) and its renderers; never imported by src/
plugins/server.ts, plugins/*/server.ts   server-side plugins, pure: candidates in, the server filters
```

Dependencies point down the list. `hooks/` imports nothing from `src/`; `ui/` and `plugins/index.ts` never import `node:*`; `src/` never imports `ui/`.

## Rules

- **State is one union, never several nullables.** The hooks module holds one `State`
  (`idle | drafting | reviewing | approved`); the server derives what is pending from the
  workspace (`pendingOf`) instead of keeping a second variable. A new feature adds a
  variant, not a flag. Before writing `let x: T | null`, name the state `null` stands for.
- **Decide, then apply.** Read everything first, take the decision as a pure function of
  plain values in `transitions.ts`, then write files, timers and prompts. The pure part is
  tested with plain calls; the applying part with a temp directory or the fake `$`.
- **Parse at the boundary, once, into a branded type.** `parseWipDir`, `parseVersion`,
  `parseProjectPath` grant `WipDir`, `Version`, `ProjectPath`; the hooks module's parsers
  read `tool_input`, `$.store` values and the server's JSON. Past the parser: no `typeof`,
  no `as`, no re-check. A `ParseResult` is returned where the caller decides; anything else
  throws, and the route or the hook turns it into an answer.
- **Fakes at the ports, nothing else faked.** The engine's `$` is the hooks module's one
  port: tests answer it from memory (`hooks/register.test.ts`). The server's port is the
  file system: tests use a temp directory. No module mocking, no spy on an internal call.
- **A test is one behaviour under fifteen lines, data in view.** Helpers hide the plumbing;
  the version, the path, the text the case turns on stay in the test. Before the code of a
  slice, its tests are listed one line each and agreed, written first, seen failing for the
  right reason.

## Not adopted

- File and function length thresholds: the pedantic oxlint and the anti-slop pack are the mechanical backstop.
- Controller / use case / port layering: `routes.ts` → `Review` → pure modules is that shape already.
- A contract test between the fake `$` and the engine: `claude plugin test` cannot raise `classic.*` events.
