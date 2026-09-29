---
paths:
  - "src/steps/**"
  - "src/formats/**"
  - "src/runtime/*/slices.ts"
  - "src/runtime/extension.ts"
  - "src/review/surface.ts"
---

# Extensions

An extension is a folder, `src/steps/<name>/` for a step Vellum follows or `src/formats/<name>/`
for a format a document is read in, and every one is a slice (`slices.md`): its `contract.ts`
declares it, and a half per runtime it plugs into fills what the declaration says: `page.tsx`
a `PageHalf` and `server.ts` a `ServerHalf`, both typed in `src/runtime/extension.ts`, and
`hooks.ts` a `HooksHalf` (`src/runtime/hooks/extension.ts`).
A half is the one way in: `PageExtension`, `ServerExtension` and `EngineExtension` are the
runtimes' own representation of a part, which each registry makes from the half, never a part.
Its part of the workflow is its model, pure and named after its folder: its region
(`regionOf`), transitions and reactions, its segment of the band, drawn on the server and sent
on the `stage` line, and its line in the workflow's view (`lineOf`, what `mcp__vellum__state`
prints); what the proof of the table reads of its region is `walk.ts` beside it, which only the
tests load. A hooks half may import the model as types only.

- Read the code before this text, smallest first: `formats/image/` is a whole slice, a
  `contract.ts` and a `page.tsx`; `formats/markdown/server.ts` a server half; `formats/html/pick.ts`
  with `pick.spec.ts` a helper and its test. They compile and they are tested, so they cannot
  drift; copy their shape.
- A contract's client is the next agent in this repository, never a third party: no module path
  may leave the plugin, so nobody outside it ships a half, and there is no dynamic loading and no
  versioned API.
- To add one: `slices.md`, in its order. Nothing else in `src/runtime/` or `src/workshop/`
  changes; when something must, the core lacks a place to plug into, and that is the change to
  propose first.
- What an extension may import is `src/boundaries.spec.ts`'s, which names each file it takes of a
  runtime (`SURFACES`) and of the review (`REVIEW_SURFACE`): one more is a decision to take, not a
  convenience. The composer is imported from `composer.tsx`, never through `surface.ts`, since
  the mockup's frame script loads `surface.ts` and must not load the page's store.
- A server half's routes are mounted at `/api/x/<id>/<name>`, behind the token, and do their IO
  through the `ServerContext` that `Queue` binds: an extension never imports the server's IO. A
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
  (`relaysOf`, then `told` in `grill/grill.ts`), so the reply End grill writes and the end both
  go, and a block written into the file by hand is not told. `proposal`'s answer to its one proposal
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
  `proposal` keeps its proposal, the last one answered and the last one dropped, and why (replaced,
  approved, written), in `.review/step.json`: a restarted server shows the proposal again,
  paused, since no call survives it, and a pick then reaches Claude as a prompt; the call's wait
  posted again opens it again, once (`wait`: a repost while it waits is a keepalive). A turn cut
  short while the call waited pauses it too (`POST pause`, which the engine half posts at the
  turn's end), and `GET state` says so (`paused`); a new proposal replaces a paused one. A round's
  answer lives in the core's memory: after a restart the round's wait reads as ended, and its
  entry reaches Claude through the channel. A round whose asking turn was cut reads paused, its
  `_(turn aborted)_` written at the round's end whoever started the turn (E6, `appendAnswer`), so
  a module that lost its `asked` mark still leaves no round reading as a call that waits.
- An extension owns its messages: its `contract.ts` types what crosses its routes, and its
  `parse.ts` is its boundary parser. `src/runtime/protocol.ts` learns nothing of them.
  A route's reply has its own name there, which both ends import (`GrillState`, `Block` in
  `grill/contract.ts`): the server half types what it hands to `Response.json`, which takes
  anything (`stateOf` and `blocksOf` in `grill/server.ts`), and the page half casts to that
  name (`loadState` and `blocksOf` in `grill/page.tsx`). A cast to a wider type that
  happens to hold the field (a whole `GrillState` for a `{ file }`) compiles, and hands the next
  reader an `undefined` typed `string`.
- What an extension does not produce itself is parsed, never cast: a request's body, a message
  from a window that runs the model's scripts, a file. The parser takes `unknown`, returns the
  type or `null`, and builds its result field by field, so nothing unnamed rides along;
  `html/parse.ts` with `parse.spec.ts` is the smallest to copy, lint-disable block included. A
  cast with its `SAFETY:` is kept for a reply of the extension's own server half.
- A hooks half loads its own folder and nothing else: the hooks module must never pull the
  server or the page in. It reaches `runtime/hooks/` as types, talks to its server half through
  `context.post` and `context.get`, and reads what comes back with the parsers of its `parse.ts`.
  Its kit tests are `<folder>/hooks.test.ts`, its fake routes `<folder>/fixtures/`: the core's
  world serves none.
- A grill's round is Claude's, `grill_ask` alone opens one, and the reviewer's reply is written in
  it, so an answer is read beside its question.
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
  through the rows of its `contract.ts`, one table the core assembles; the module owns whether a server and a lock exist; a file owns its content,
  and what is read off it: a grill's phase is the server's reading of the transcript (`phaseOf`),
  handed to the page in `GET state`, never derived again from the blocks.
  A fact with two owners drifts at the first reload.
- An extension's classes in `runtime/page/style.css` carry its id as a prefix (`.grill-doc`,
  `.grill-q`): the stylesheet is global, and a bare `.grill` also styled the `.btn.grill` button.
- A helper and its `*.spec.ts` live in the folder, beside the half that uses them: its choice
  is a pure function tested with `bun test`, which has no DOM, and its DOM part a thin adapter
  the browser suite drives through the whole page.
- A new document kind is a new extension, never a branch in an existing renderer.
- An option or a flag exists when someone asked to turn it, never in advance. Config files,
  manifests and `enabled` are not designed yet: skills and agents load with the plugin, so a
  config cannot hide one per repository (the module could only refuse it at `skill.prompt`), and
  `userConfig` ignores project entries, so a per-repository config would be a file of Vellum's
  own. The last design: `extension-contract.md` in
  `plans/2026-09-17/extensions-de-vellum-arbre-noms-et-garde-fous/`.
- `src/boundaries.spec.ts` fails, naming the file, when any of this is broken. An import it
  refuses is in the wrong place, not a rule to loosen.
