---
paths:
  - "src/runtime/server/**"
  - "src/runtime/protocol.ts"
---

# The server

The server, `src/runtime/server/`, around the pure core, `src/workshop/` (`workshop.md`).
`queue.ts` is the queue and the step: every change of the workflow is an event, which `Queue.step` reads (the
`Workflow`: the directory, `plan.md`, each extension's region), judges with `next` against the
table (`workshop/workflow.ts`), and hands to `interpret` (`effects.ts`), the one code that
writes for the workflow; `review/server.ts` reads what the review's own routes carry (the gate,
Record, the approval, the Send). The IO is plain modules, no interface, no injection: `fs.ts` every read and
write under the project root, `http/routes.ts` bodies, paths and status codes, handing the review's to `review/routes.ts`,
`http/serve.ts` binding and the page bundle, `browser.ts` the opener, `vellum-build.ts` the
plugin's own version and commit, read once at start from outside the project (`plugin.json`,
Claude Code's `installed_plugins.json`, `git` with its `GIT_*` variables cleared). Direction held by
`src/boundaries.spec.ts`.

- Decide, then apply. Read everything first, in the step (a route's `Reading`), take the
  decision as a pure function of plain values (`next`, and the rows each extension brings), then
  write through the effects `next` answered. No refusal is written outside the table.
- State is derived, never stored twice: where the review stands is `workspaceOf` of the
  workshop, off the listing and the memory `Queue` keeps, never a second variable.
- Parse at the boundary, once, into the workshop's branded types. Past the parser: no `typeof`,
  no `as`, no re-check. A `ParseResult` is returned where the caller decides; anything else
  throws, and the route turns it into an answer.
- `src/runtime/protocol.ts` is the one place a value crossing HTTP, the server's stdout or an
  extension boundary is typed; it re-exports the workshop's types it carries, never redefines them. What an extension
  hands the core is typed beside it, in `src/runtime/extension.ts`.
- `Queue` binds the `ServerContext` of `src/runtime/extension.ts` to itself and to `fs.ts`, since
  a step runs there; `http/serve.ts` hands the same context to each extension's routes and mounts them under `/api/x/<id>/`; `routes.ts` looks them
  up after its own, behind the same token check, and knows none by name.
- What holds the review is read off the workflow: `held`, the reason of the first region that
  holds, in the registry's order, as each extension's `regionOf` says it. Held has one meaning,
  written once per event (`whileHeld`): `record` is refused with the reason and no version of
  Claude's lands, the refusal journaled and promising none; every other event a part declares
  held is refused, the hold its reason (`table.spec.ts.snap` lists them, `passes a hold` marks the
  rest); a Send and an approval go through, the reviewer's word never held,
  the approval once a confirmation names that very hold (`Decision.confirmed`: another hold
  asks again). A Send's edit is the one part that waits (`sendEdit` is refused): it stays in the
  draft with the comments on the plan's lines, which are the edit's, the rest goes, and the
  answer says so (`editKept`, its `reason` what holds); an edit alone is refused by the hold's
  row (`refused`, rule `held`), and every other refusal of a Send names its row and its text.
  `ReviewView.workflow` and `GET /api/workflow` carry the workflow as a reader takes it
  (`viewOf`: each region's state, hold, wait and line in its extension's words, never its files;
  what is refused now, each event once, in the words a real caller
  meets, never on a row that turns only the input down (`Rule.refuses`), nor what the engine
  alone sends), and the
  `stage` line carries the pill and the segments to the band (`stageOf`: the plan's, then each
  extension's `segment`), told after each step that passed from the workflow `next` answered.
  The core names no extension: each brings its rows.
- The notice: the step that lifts the last hold while `plan.md` holds a text no version has tells
  Claude once, a `channel` entry from `core`, with or without a verdict (`endsWithoutVerdict`);
  the end of Claude's next turn records the version. Nothing else records a text a hold kept
  back. `plan.md` written is itself an event, `planWritten`, dispatched at start when the file is
  there (P10) and each time the watcher sees its text change (`serve.ts`); the approval is
  refused while it holds a text the version under review lacks (`approve-draft`).
- An extension starts what another runs through `ServerContext.start(id, input)`, which answers
  the sentence the started extension tells Claude: `proposal`'s answer carries the grill's opening in
  its one entry. The table judges whether it opens (the grill's rows, declared on `answerProposal`
  too), and the started extension's reaction writes it, in the same step, so two grills never
  open. The core passes `input` on untouched, and the started extension's `parse.ts` reads it.
- One queue orders every step: an event dispatched (`ServerContext.dispatch`, and the core's own
  through `review/server.ts`), and a read a step must see whole through `ServerContext.inOrder`. A gate
  that saw no hold records its version before a grill that opened meanwhile, never after. A
  route's `Reading` and every region's read run inside the step and never call the queue.
- `interpret` runs a step's effects in order. The commit point is the step's first entry of the
  channel or its rename (`approveDirectory`): before it a write that fails fails the step, and
  the route answers 500 naming the effect (`EffectFailed`), an entry that fails removing the files
  the step created; past it a failure is logged, since Claude or the rename took the step. A
  rename that fails keeps its error in the memory and stops the rest. Every event judged is a
  line of `.review/events.jsonl` (`JOURNAL_FILE`), a refused one included; a line that fails
  fails nothing, and the workflow is never rebuilt from it. `GET /api/workflow` answers where
  the review lives with the workflow as a reader takes it (`WorkflowAnswer`); it and
  `Queue.view` read the workflow inside the queue, where no step is half applied (a step writes
  its files before it keeps a proposal's wait in memory). `POST /api/record` is `record` for the
  reviewer.
- Everything that reaches Claude is an entry of the channel, `.review/channel.jsonl`
  (`workshop/channel.ts`), appended inside the queue by `Queue`'s relay: the core's `sent` for a
  batch written and `approved` after the rename, an extension's own `text` as a `channel` effect
  of its transition, beside the write it tells of. A call that waits takes the entry its step
  appended before a `returnToCall` as its result (`ServerContext.returned`), so it reaches
  Claude once. An entry's number is its line; the file is
  never rewritten but by the approval's link rewrite and the migration below, which move no
  line, and a last line left without a newline is ended before an entry is appended. Its
  identity, `.review/channel.id`, is minted with it and moves with the rename.
  `Queue.openChannel` runs before `ready`: it renames an older vellum's `v<N>.feedback.md`, one
  per version, to that version's first batch (`legacyBatch`), the entries naming it renamed with
  it (`renamedIn`); then it appends what the directory implies and the channel lacks (`untold`: a `sent` per batch no entry
  names, the approval of an approved directory), so a write whose entry was lost is told
  at the next start, and a directory with no channel yet tells nothing of what it held.
  `cli.ts serve` writes each entry on stdout as it lands (`ServerLine`: `ready` first, then the
  entries and the review's changes, and nothing else goes there), and `GET /api/channel?after=<n>`
  reads the file again, for a module that relaunched the server or missed a line; a line that is
  no entry is left out, never answered in its place.
- An approval closes what an extension left open on the server, through the extension's
  reaction to `approve`, whose effects run after the rename and with the memory set, so a file
  lands in the final directory. No module has to be alive for it, and a write that fails there
  leaves the plan approved.
- The module's heartbeat or a reviewer's tab keeps the server: the watchdog expires it once the
  last heartbeat is past the grace and no event stream is open. A tab holds it for a bounded
  time only (`tabHoldMs`): a `claude` killed with its terminal open leaves a server its module
  never beats again, and a tab still listening to it must not keep it for good. `routes.ts` counts the streams,
  since the review's own listeners include one `serve.ts` keeps for itself; the same count
  decides whether `POST /api/open` and a gate open the browser.
- `--token` and `--port` revive a server where its tabs expect it. A port taken meanwhile binds
  another one under a new token, never the kept one: the event stream's URL carries the token,
  so whoever took the port reads it from every tab that reconnects. `--existing` refuses a
  working directory that is gone (`WorkdirGone`, exit 3, before a line on stdout) instead of
  creating it; with `--final`, the server starts on the directory an approval renamed it to,
  approved in memory, and watches and creates nothing.
- A version is a text somebody handed over for review, Claude through `gate` or the reviewer
  through a Send or an approval that carries an `Edit`. `sendOn` and `decideOn` decide it,
  purely: the version the Send or the approval applies to, the version file to write, the
  comments retargeted to it, the notes file. An `Edit` names the version it edits, and one of
  another version is refused (a Send's 409 `stale`): a bare text sent after Claude recorded
  `vN+1` would overwrite that revision and tell Claude to keep it. `vN.md` stays what its author
  submitted.
- One Send, `send` of `review/server.ts`, is one step of the queue, what the reviewer sends from the page's one
  button or from a comment's Send now. Its `SendRequest` names what the reviewer saw at the
  click: the comment ids, the edit's version or `null`, the choices made in mockups by their
  mockup, decision and option, whether the extensions' parts go (the
  bar's Send, never Send now), and the question ids the reviewer agreed to leave to their
  recommendation. It is judged before anything is written but a refusal's journal line, by the
  `send` rows on what the stored draft makes of the names (`namedIn`): a name the draft no longer holds, a choice whose option
  changed included (409 `changed`), an edit of a version no longer under review (`stale`), a
  comment on the plan named without the pending edit whose lines `Done` moved it to (`edit`), an
  approved plan (`approved`); each extension's `part` answers the questions no answer takes
  outside those agreed (409 `unanswered`, every id); nothing to send is `empty`, and a draft the
  server cannot read `unreadable`: those three are the route's answers, not rows. Then the edit
  lands as the next version (`sendEdit`); the batch `.review/v<N>.feedback-<k>.md`, `v0` while
  drafting, `k` the next on that version; its `sent` entry, the commit point: an entry that fails
  removes the batch, and past it nothing throws. Then, each failure logged and the Send still
  answered 200: each extension's reaction to the Send's event, which carries each part's `input`
  and whether the batch holds more than its part (`comments`); the notification; the draft's
  rest, what the Send did not take. A Send
  changes no stage: the version stays under review, `workspace.batches` counts its batches, and a
  gate after one records a new version even with the same text (`gateVersion`). The server sends
  from the draft it keeps, never a body: the page writes it first.
- The approval (`approve`, then `approveDirectory` in `queue.ts`) applies in an order where a
  write that fails leaves a state the next `gate` or the next load repairs: `plan.md` before the
  edit's version file, the notes file and the draft's removal before the rename, which carries
  what is there. The final directory's free name is read before the step (`freeTarget`), and the
  rename lands exactly there. A `null` from `formatNotes`
  writes nothing and keeps a notes file already there: a retry after a failed rename carries no
  note. Whether the approval's prompt names a notes file is read from the final directory's
  listing, never from the decision.
- The draft is the page's, stored and read back through the one parser, `review/draft.ts`:
  `PUT /api/draft` parses the comments, the edit, the choices made in mockups and what is typed,
  and `Queue.draft` runs the file through the same parser for `GET`, a Send and
  `ServerContext.draft`, so a malformed draft is refused whole, with `UNREADABLE_DRAFT` as the
  reason, never handed over half-read. A choice's mockup is kept under its path as parsed, so a
  Send that names it finds it, and two spellings of one path are refused. Two older shapes are
  read, since refusing either loses every unsent comment of the draft, and a tab loaded before a
  revived server keeps sending it: a mockup comment saved before `ElementRef.description`, whose
  description is `null` and whose feedback line names the element by its label; and a draft with
  no `choices`, read as none. A Send the server cannot parse is a 400, which the page reads as a
  page older than its server, and says to reload. `saveDraft` writes one with content
  only where `takesComments` holds and answers 409 elsewhere, since a write would recreate a
  directory the approval has just renamed; an empty one removes the file in any state. A draft
  write raises no workspace event: `watchFiles` leaves `.review/` to the server.
