---
paths:
  - "src/core/server/**"
  - "src/core/protocol.ts"
---

# The server

Hexagonal with a functional core, under `src/core/server/`. `domain/` is pure functions over
immutable data: no `node:*`, no `bun`, no adapter, app or page import. `app/review.ts` is the
one use case: read through the adapter, decide in the domain, apply files, memory and
listeners. `adapters/` are plain modules, no interface, no injection: `fs.ts` every read and
write under the project root, `draft.ts` the draft's one parser, `http/routes.ts` bodies, paths and status codes,
`http/serve.ts` binding and the page bundle, `browser.ts` the opener, `vellum-build.ts` the
plugin's own version and commit, read once at start from outside the project (`plugin.json`,
Claude Code's `installed_plugins.json`, `git` with its `GIT_*` variables cleared). Direction held by
`src/boundaries.spec.ts`.

- Decide, then apply. Read everything first, take the decision as a pure function of plain
  values in `domain/`, then write files, timers and prompts through `adapters/`.
- State is derived, never stored twice: where the review stands comes from the directory's
  listing and the memory (`domain/workspace.ts`, `workspaceOf`), not from a second variable. A new
  feature adds a variant to a union, not a flag.
- Parse at the boundary, once, into a branded type: `parseWipDir`, `parseVersion`,
  `parseProjectPath` grant `WipDir`, `Version`, `ProjectPath`. Past the parser: no `typeof`,
  no `as`, no re-check. A `ParseResult` is returned where the caller decides; anything else
  throws, and the route turns it into an answer.
- `src/core/protocol.ts` is the one place a value crossing HTTP, the server's stdout or an
  extension boundary is typed; it re-exports the domain types it carries, never redefines them. What an extension
  hands the core is typed beside it, in `src/core/extension.ts`.
- `Review` binds the `ServerContext` of `src/core/extension.ts` to itself and to `fs.ts`, since
  it is `Review` that calls an extension's `holds` and `approved`; `http/serve.ts` hands the same
  context to each extension's routes and mounts them under `/api/x/<id>/`; `routes.ts` looks them
  up after its own, behind the same token check, and knows none by name.
- An extension may hold the review: `holds` answers what holds it, or `null`. Held has one
  meaning, so there is no list of what is blocked: `gate` is refused with the reason before
  `plan.md` is read (the 409 the module already reads), no version of Claude's lands, and a Send
  and an approval go through: the reviewer's word is never held. `ReviewView.held` carries the
  reason to the page. The core names no extension: it appends what a gate means to the reason.
- One queue orders every mutation: `gate`, `decide`, `send`, and an extension's writes through
  `ServerContext.inOrder`. A gate that checked the hold writes its version before a grill that
  opened meanwhile, never after. `holds` and `approved` run inside the queue and never call it.
- Everything that reaches Claude is an entry of the channel, `.review/channel.jsonl`
  (`domain/channel.ts`), appended inside the queue by `Review`'s relay: the core's `sent` for a
  batch written and `approved` after the rename, an extension's own `text` through
  `ServerContext.relay`, at the write it tells of. An entry's number is its line; the file is
  never rewritten but by the approval's link rewrite, which moves no line, and a last line left
  without a newline is ended before an entry is appended. Its identity, `.review/channel.id`, is
  minted with it and moves with the rename. `Review.openChannel` runs before `ready`: it appends
  what the directory implies and the channel lacks (`untold`: a `sent` per batch no entry
  names, the approval of an approved directory), so a write whose entry was lost is told
  at the next start, and a directory with no channel yet tells nothing of what it held.
  `cli.ts serve` writes each entry on stdout as it lands (`ServerLine`: `ready` first, then the
  entries and the review's changes, and nothing else goes there), and `GET /api/channel?after=<n>`
  reads the file again, for a module that relaunched the server or missed a line; a line that is
  no entry is left out, never answered in its place.
- An approval closes what an extension left open on the server, through `approved`, after the
  rename and with the memory set, so `workspace().dir` is the final directory. No module has to
  be alive for it, and an extension that throws there leaves the plan approved.
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
- A new domain concept gets its address in `domain/` before its first line.
- A version is a text somebody handed over for review, Claude through `gate` or the reviewer
  through a Send or an approval that carries an `Edit`. `sendOn` and `decideOn` decide it,
  purely: the version the Send or the approval applies to, the version file to write, the
  comments retargeted to it, the notes file. An `Edit` names the version it edits, and one of
  another version is refused (a Send's 409 `stale`): a bare text sent after Claude recorded
  `vN+1` would overwrite that revision and tell Claude to keep it. `vN.md` stays what its author
  submitted.
- One Send, `Review.send`, is one step of the queue, what the reviewer sends from the page's one
  button or from a comment's Send now. `all` asks the extensions' `unanswered` first, and a
  total above zero is a 409 with the count unless the Send takes the defaults; `sendOn` decides
  purely what leaves the draft; each extension's `section` writes its part, the grill's reply
  closing its round (named items leave the round alone, so they ask no extension); then the batch
  `.review/v<N>.feedback-<k>.md`, `v0` while drafting, `k` the next on that version, the edit's
  version once it lands; the draft's rest; the `sent` entry; then each extension's `sent`, which
  hears the entry's number and whether the batch holds more than its part. Nothing to send is a
  409 `empty`, an approved plan `approved`. A Send changes no stage: the version stays under
  review, `workspace.batches` counts its batches, and a gate after one records a new version
  even with the same text (`gateVersion`). The server sends the draft it keeps, never a body: the
  page writes it first.
- `Review.decide` applies in an order where a write that fails leaves a state the next `gate`
  or the next load repairs: `plan.md` before the edit's version file, the notes file and the
  draft's removal before the rename, which carries what is there. A `null` from `formatNotes`
  writes nothing and keeps a notes file already there: a retry after a failed rename carries no
  note. Whether the approval's prompt names a notes file is read from the final directory's
  listing, never from the decision.
- The draft is the page's, stored and read back through the one parser, `adapters/draft.ts`:
  `PUT /api/draft` parses the comments, the edit and what is typed, and `Review.draft` runs the
  file through the same parser for `GET`, a Send and `ServerContext.draft`, so a draft of an older
  shape is refused whole, with `UNREADABLE_DRAFT` as the reason, never handed over half-read. One older shape is read: a mockup comment saved
  before `ElementRef.description`, whose description is `null` and whose feedback line names the
  element by its label, since refusing it loses every unsent comment of the draft, and a tab
  loaded before a revived server keeps sending that shape. `saveDraft` writes one with content
  only where `takesComments` holds and answers 409 elsewhere, since a write would recreate a
  directory the approval has just renamed; an empty one removes the file in any state. A draft
  write raises no workspace event: `watchFiles` leaves `.review/` to the server.
