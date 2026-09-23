---
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "e2e/**"
---

# Tests

- Three suffixes, three runners: `*.spec.ts` for the server's and the page's `bun:test` suites,
  `*.test.ts` for the hooks module's kit tests, in `src/core/engine/` and, for an engine half,
  `src/extensions/<id>/engine.test.ts`, and `*.e2e.ts` for the browser suite in `e2e/`, which
  Playwright runs (`bun run --cwd vellum e2e`) and neither of the other two collects. `claude plugin
  test` collects every `*.test.ts` under the plugin root and loads the module
  `<root>/hooks/hooks.json` names, so a `bun:test` suite named `*.test.ts` anywhere in the
  plugin fails its run.
- The browser suite measures what no fake DOM sees: geometry, contrast, focus, a scrollbar. Its
  harness is `e2e/harness.ts`: the `vellum` fixture starts `preview.ts` on a copy of the fixture
  `test.use({ fixture })` names (`rich` by default), one server per test, and drives it through
  the API as the hooks module does (`gate`, `grill.*`); `axe` and `contrast` are its two measures.
  `e2e/playwright.config.ts` runs every suite at the audit's five windows. A test whose subject
  is another width sets it with `test.use({ viewport })`, before `page.goto`, since `readWindow`
  reads the width once per load, and runs on `light-1440` alone (`test.skip` on
  `info.project.name`): its viewport replaces every project's. A test ends with the
  page in a state the fixture documents, never with a screenshot compared to a golden file: a
  pixel diff says that something moved, an assertion says what. Chromium is installed once per
  machine and per pinned version (`bun run --cwd vellum e2e:install`); CI runs the suite in its
  own job, and no hook does, since it takes seconds per file. A red e2e test is reproduced on
  its own file and project (`-- <file> --project=<name>`), never by rerunning the suite; the
  whole suite runs once on `light-1440` before a push, and at the five windows in CI only, on
  request: the `e2e` label on a PR, or `workflow_dispatch`.
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
- The page's ports are the browser's globals it reads: `fetch`, `EventSource`, `location`,
  `window.matchMedia`. A suite puts a fake there for one test and takes it away after (`port` in
  `core/page/state.spec.ts`); `api.ts` is never mocked. The store is module state, and one
  `bun test` run keeps one module registry for all its suites: a suite that drives `state.ts`
  imports it for each test under a query no import used before (`freshStore`, same file), so no
  signal, and no saving effect `start` leaves behind, reaches another test or another suite. The
  query is random, not counted: `--rerun-each` evaluates the suite again, its counter with it, and
  the registry still holds the stores of the first pass.
- The kit cannot raise one case: the lock's overrun. `mock.clock` lets a wait held past a
  hook's budget go, and a test's own budget is shorter still, so a hook that outruns the
  dispatch is measured in a live session instead ([Hook tests](../../../docs/plugin-testing/hooks.md)).
- A rule only the type system holds is locked where it is tested: a
  `// @ts-expect-error -- <reason>` line in the suite beside it, on the code that must not
  compile. The typecheck gate reads the suites, and a directive with nothing under it fails
  the gate, so the day the type loosens the suite says so. `grill/server.spec.ts` holds two:
  the body of `close`, the reply to `open`. `core/page/kit.spec.ts` holds the kit's: a component
  is a function, so a suite calls it with props and reads the vnode it returns, with no DOM. The
  directive sits on a line that also runs, so the test says what the refused code would do.
- `src/boundaries.spec.ts` holds the dependency direction; an import that fails it is in the
  wrong layer, not a test to loosen.
