---
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
---

# Tests

- Two suffixes, two runners: `*.spec.ts` for the server's and the page's `bun:test` suites,
  `*.test.ts` for the hooks module's kit tests, in `src/core/engine/` and, for an engine half,
  `src/extensions/<id>/engine.test.ts`. `claude plugin
  test` collects every `*.test.ts` under the plugin root and loads the module
  `<root>/hooks/hooks.json` names, so a `bun:test` suite named `*.test.ts` anywhere in the
  plugin fails its run.
- One behaviour per test, under fifteen lines, data in view: helpers hide the plumbing; the
  version, the path, the text the case turns on stay in the test.
- Before the code of a slice, its tests are listed one line each and agreed, written first,
  seen failing for the right reason.
- A test proves something once it was seen failing: written first and seen red, or the code
  mutated afterwards until the test falls. The commit message says which. Green tests that
  were never red only repeat the author's model.
- A fake must be able to disagree with the code. A fixture that returns the value under test
  by construction, as a bottom-of-chain hook answering `{ text: e.answer }`, hides a hook that
  reads the wrong field.
- A file read by its structure is tested with a text that holds the structure's own markers:
  a heading, a footer, an event line typed inside an answer. Its author is a model, and it
  writes them.
- Fakes at the ports, nothing else faked: the hooks module runs under the engine's own `$`,
  with the world beneath it answered by `mock.clock` and the `on(...)` hooks of
  `src/core/engine/fixtures/`; the server's file system is a temp directory through the real
  adapter; `adapters/http` starts the server on port 0. No module mocking, no spy on an
  internal call.
- The kit cannot raise one case: the lock's overrun. `mock.clock` lets a wait held past a
  hook's budget go, and a test's own budget is shorter still, so a hook that outruns the
  dispatch is measured in a live session instead (`docs/plugin-testing.md`).
- A rule only the type system holds is locked where it is tested: a
  `// @ts-expect-error -- <reason>` line in the suite beside it, on the code that must not
  compile. The typecheck gate reads the suites, and a directive with nothing under it fails
  the gate, so the day the type loosens the suite says so. `grill/server.spec.ts` holds two:
  the body of `close`, the reply to `open`.
- `src/boundaries.spec.ts` holds the dependency direction; an import that fails it is in the
  wrong layer, not a test to loosen.
