---
paths:
  - "src/extensions/**"
  - "src/core/extension.ts"
---

# Extensions

An extension is a folder, `src/extensions/<id>/`, with one file per place where it plugs into
the core: `page.tsx` declares a `PageExtension` (its renderers, its actions in the decision
bar, its notices under the bar, its panel beside the document pane, placed by `panesOf`),
`server.ts` a `ServerExtension` (its `linkedDocs`, its routes, its `workflow`, its part of a
Send, what another extension may `start`). Both types live in `src/core/extension.ts`. Its part
of the workflow is `workflow.ts`, pure: its region (`regionOf`), its events, rows, transitions
and reaction to the others' events, and its segment of the band; the server half hands it to the
core with its region's read, and an engine half may import it as types only. `markdown`, `html`, `image`, `grill` and `step` are
extensions like the next ones. A third half,
`engine.ts`, declares an `EngineExtension` (`src/core/engine/extension.ts`): tools, refusals,
the engine events the core hands it, and its segment of the band above the prompt. `grill`, `step` and `review` have all three.

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
  route that changes the workflow dispatches its event (`ServerContext.dispatch`), in the
  review's one queue, and writes nothing itself: its transitions' effects are the writes, and a
  refusal is the reason of the row that refused it. It keeps no queue of its own; what it reads
  before the event is judged is a `Reading`, run inside the step. `workspace().dir` moves at the
  approval, so a route resolves it at each read and never keeps it. Each step that passed tells
  the page; the watcher tells it of the files Claude writes. The page half calls its routes with `extensionRequest`.
- What reaches Claude goes through the core's channel, never a memory of the extension's own:
  the extension words its `text` as a `channel` effect of its transition, beside the write it
  tells of, and the core relays each entry once. It tells what its write added, never the file's
  last voice: `grill` tells the transcript's entries past those the file held before the write
  (`relaysOf`, then `told` in `grill/workflow.ts`), so the reply End grill writes and the end both
  go, and a block written into the file by hand is not told. `step`'s answer to its one proposal
  carries, in its one entry, what the grill it opened tells (`start`).
- What the reviewer sends leaves with the core's one Send, never a route of the extension's.
  `part` answers, writing nothing, what the bar's Send takes of the extension, never a Send now:
  nothing; the questions no answer takes that the reviewer did not agree to leave to their
  recommendation, every one, so the page asks about all; or its text, what the draft keeps of
  its typing, and an `input` the Send's event carries to the extension's reaction, which closes
  the grill's round once the batch and its entry exist. What the draft holds for an extension is read from the `Draft` the core hands
  it, or from `ServerContext.draft` for a route, inside the route's own step of the queue (End
  grill ends with what is typed as the reply, never what a Send took before it). A tool
  that waits for the reviewer is answered through the core: the step that answers a call waiting
  hands it the answer (`returnToCall`, read with `ServerContext.returned`), and `POST wait` is
  held by `ServerContext.hold`, `WAIT_HOLD_MS` under the engine's 30 s cut, read again after
  every step; it answers the entry number and the text the tool returns, an end, or still open.
  `step` keeps its proposal, the last one answered and the last one dropped, and why (replaced,
  approved, written), in `.review/step.json`: a restarted server shows the proposal again,
  paused, since no call survives it, and a pick then reaches Claude as a prompt; the call's wait
  posted again opens it again, once (`wait`: a repost while it waits is a keepalive). A round's
  answer lives in the core's memory: after a restart the round's wait reads as ended, and its
  entry reaches Claude through the channel.
- An extension owns its messages: `<id>/protocol.ts` types what crosses its routes, and
  `<id>/parse.ts` is its boundary parser. `src/core/protocol.ts` learns nothing of them.
  A route's reply has its own name there, which both ends import (`GrillState`, `Block` in
  `grill/protocol.ts`): the server half types what it hands to `Response.json`, which takes
  anything (`stateOf` and `blocksOf` in `grill/server.ts`), and the page half casts to that
  name (`loadState` and `blocksOf` in `grill/page.tsx`). A cast to a wider type that
  happens to hold the field (a whole `GrillState` for a `{ file }`) compiles, and hands the next
  reader an `undefined` typed `string`.
- What an extension does not produce itself is parsed, never cast: a request's body, a message
  from a window that runs the model's scripts, a file. The parser takes `unknown`, returns the
  type or `null`, and builds its result field by field, so nothing unnamed rides along;
  `html/parse.ts` with `parse.spec.ts` is the smallest to copy, lint-disable block included. A
  cast with its `SAFETY:` is kept for a reply of the extension's own server half.
- An engine half loads its own folder and nothing else: the hooks module must never pull the
  server or the page in. It reaches `core/engine/` as types, talks to its server half through
  `context.api`, and parses what comes back in its `parse.ts`. Its kit tests are
  `<id>/engine.test.ts`, its fake routes `<id>/fixtures/`: the core's world serves none.
- A file whose structure is read off its lines never takes a text as it comes: `grill`'s
  transcript quotes Claude's text (`quoted` in `transcript.ts`), or a heading typed in an answer
  speaks for the reviewer, opens a round or closes the grill, and a `_(turn aborted)_` line stops
  a turn that ended on its answer. It quotes a question's texts further (`quotedQuestion`), or a
  rule, a `❓` or a `➡️` line cuts its card. It quotes the
  reviewer's answers and note too (`quotedReviewer`, reversed for the page and for Claude), or a
  `### ` line in an answer cuts the reply relayed and a `Q3: ` line in a note answers Q3. A text written as
  one line, a grill's subject in its header or a question's title on its line, is refused at the
  parser when it holds a line break, and a title too when its line's reader would cut it: empty,
  holding `**` or ending in `*` (`titleText` in `grill/parse.ts`), and a question with a blank
  recommendation, which an answer left out takes by default (a hand-typed question with no `➡️`
  is still read, its field alone); a text that shares its first line with a marker, a
  question's text and its recommendation, takes `\n` for every break, since that line is read by
  `\n` alone.
- An extension with states, rounds or a lifecycle starts with a table, before any code: the
  states, the events, and one owner per fact. The server owns what is allowed and says it
  through the rows of `workflow.ts`, one table the core assembles; the module owns whether a server and a lock exist; a file owns its content,
  and what is read off it: a grill's phase is the server's reading of the transcript (`phaseOf`),
  handed to the page in `GET state`, never derived again from the blocks.
  A fact with two owners drifts at the first reload.
- An extension's classes in `core/page/style.css` carry its id as a prefix (`.grill-doc`,
  `.grill-q`): the stylesheet is global, and a bare `.grill` also styled the `.btn.grill` button.
- A helper and its `*.spec.ts` live in the folder, beside the half that uses them: its choice
  is a pure function tested with `bun test`, which has no DOM, and its DOM part a thin adapter
  the browser suite drives through the whole page.
- A new document kind is a new extension, never a branch in an existing renderer.
- An option or a flag exists when someone asked to turn it, never in advance. Config files,
  manifests and `enabled` are not designed yet; where the question stands is `docs/architecture.md`
  § Extensions.
- `src/boundaries.spec.ts` fails, naming the file, when any of this is broken. An import it
  refuses is in the wrong place, not a rule to loosen.
