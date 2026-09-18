---
paths:
  - "src/extensions/**"
  - "src/core/extension.ts"
---

# Extensions

An extension is a folder, `src/extensions/<id>/`, with one file per place where it plugs into
the core: `page.tsx` declares a `PageExtension` (its renderers, its actions in the decision
bar), `server.ts` a `ServerExtension` (its `linkedDocs`, its routes). Both types live in
`src/core/extension.ts`. `markdown`, `html`, `image` and `grill` are extensions like the next
ones. A third half,
`engine.ts`, declares an `EngineExtension` (`src/core/engine/extension.ts`): tools, refusals
and the engine events the core hands it. `grill` is the one extension with all three.

- Read the code before this text, smallest first: `image/page.tsx` is a whole extension,
  `markdown/server.ts` a server half, `html/pick.ts` with `pick.spec.ts` a helper and its
  test. They compile and they are tested, so they cannot drift; copy their shape.
- To add one: the folder, its halves, and one line per registry (`src/extensions/page.ts`,
  `src/extensions/server.ts`, `src/extensions/engine.ts`). A half is `export const <name>: PageExtension = { id: "<id>", … }`
  (or `ServerExtension`), and its `id` is the folder's name. Nothing else in `src/core/`
  changes; when something must, the core lacks a place to plug into, and that is the change
  to propose first.
- An extension imports `src/core/` and its own folder, never `../<another>/`. From
  `src/core/page/` it imports the files `PAGE_SURFACE` lists in `src/boundaries.spec.ts`: one
  more is a decision to take, not a convenience.
- A server half's routes are mounted at `/api/x/<id>/<name>`, behind the token, and do their IO
  through the `ServerContext` that `serve.ts` binds: an extension never imports an adapter.
  `workspace().dir` moves at the approval, so a route resolves it at each write and never keeps
  it. What the watcher cannot see (a state kept in memory, a write after the approval) reaches
  the page through `notify`. The page half calls its routes with `extensionRequest`.
- An extension owns its messages: `<id>/protocol.ts` types what crosses its routes, and
  `<id>/parse.ts` is its boundary parser. `src/core/protocol.ts` learns nothing of them.
- An engine half loads its own folder and nothing else: the hooks module must never pull the
  server or the page in. It reaches `core/engine/` as types, talks to its server half through
  `context.api`, and parses what comes back in its `parse.ts`. Its kit tests are
  `<id>/engine.test.ts`, its fake routes `<id>/fixtures/`: the core's world serves none.
- A helper and its `*.spec.ts` live in the folder, beside the half that uses them: its choice
  is a pure function tested with `bun test`, its DOM part a thin adapter, since the page has
  no DOM implementation to test against.
- A new document kind is a new extension, never a branch in an existing renderer.
- An option or a flag exists when someone asked to turn it, never in advance. Config files,
  manifests and `enabled` are not designed yet; where the question stands is `docs/architecture.md`
  § Extensions.
- `src/boundaries.spec.ts` fails, naming the file, when any of this is broken. An import it
  refuses is in the wrong place, not a rule to loosen.
