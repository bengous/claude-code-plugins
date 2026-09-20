---
paths:
  - "src/extensions/**"
  - "src/core/extension.ts"
---

# Extensions

An extension is a folder, `src/extensions/<id>/`, with one file per place where it plugs into
the core: `page.tsx` declares a `PageExtension` (its renderers, its actions in the decision
bar), `server.ts` a `ServerExtension` (its `linkedDocs`, its routes, what `holds` the review,
what it closes once `approved`). Both types live in
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
  through the `ServerContext` that `Review` binds: an extension never imports an adapter. A
  route that writes goes through `inOrder`, the review's one queue, and keeps no queue of its
  own; `holds` and `approved` are called from inside that queue and write directly.
  `workspace().dir` moves at the approval, so a route resolves it at each write and never keeps
  it. What the watcher cannot see (a state kept in memory, a write after the approval) reaches
  the page through `notify`. The page half calls its routes with `extensionRequest`.
- What an engine half relays is a cursor over entries the server numbers, never "the last one":
  `grill` asks `state?after=<seq>&file=<name>` and submits every entry past it, in order, the
  cursor written after each. A rule that reads the file's last voice loses a reply whenever two
  land between two polls.
- An extension owns its messages: `<id>/protocol.ts` types what crosses its routes, and
  `<id>/parse.ts` is its boundary parser. `src/core/protocol.ts` learns nothing of them.
  A route's reply has its own name there, which both ends import (`Opened`, `Asked` in
  `grill/protocol.ts`): the server half builds a constant of that type before `Response.json`,
  which takes anything, and the page half casts to that name. A cast to a wider type that
  happens to hold the field (a whole `GrillState` for a `{ file }`) compiles, and hands the next
  reader an `undefined` typed `string`.
- An engine half loads its own folder and nothing else: the hooks module must never pull the
  server or the page in. It reaches `core/engine/` as types, talks to its server half through
  `context.api`, and parses what comes back in its `parse.ts`. Its kit tests are
  `<id>/engine.test.ts`, its fake routes `<id>/fixtures/`: the core's world serves none.
- A file whose structure is read off its lines never takes a text as it comes: `grill`'s
  transcript quotes Claude's text (`quoted` in `transcript.ts`), or a heading typed in an answer
  speaks for the reviewer, opens a round or closes the grill.
- An extension with states, rounds or a lifecycle starts with a table, before any code: the
  states, the events, and one owner per fact. The server owns what is allowed and says it
  through `holds`; the module owns whether a server and a lock exist; a file owns its content.
  A fact with two owners drifts at the first reload.
- An extension's classes in `core/page/style.css` carry its id as a prefix (`.grill-doc`,
  `.grill-q`): the stylesheet is global, and a bare `.grill` also styled the `.btn.grill` button.
- A helper and its `*.spec.ts` live in the folder, beside the half that uses them: its choice
  is a pure function tested with `bun test`, its DOM part a thin adapter, since the page has
  no DOM implementation to test against.
- A new document kind is a new extension, never a branch in an existing renderer.
- An option or a flag exists when someone asked to turn it, never in advance. Config files,
  manifests and `enabled` are not designed yet; where the question stands is `docs/architecture.md`
  § Extensions.
- `src/boundaries.spec.ts` fails, naming the file, when any of this is broken. An import it
  refuses is in the wrong place, not a rule to loosen.
