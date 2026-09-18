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
write under the project root, `http/routes.ts` bodies, paths and status codes,
`http/serve.ts` binding and the page bundle, `browser.ts` the opener. Direction held by
`src/boundaries.spec.ts`.

- Decide, then apply. Read everything first, take the decision as a pure function of plain
  values in `domain/`, then write files, timers and prompts through `adapters/`.
- State is derived, never stored twice: what is pending comes from the workspace
  (`domain/workspace.ts`, `pendingOf`), not from a second variable. A new feature adds a
  variant to a union, not a flag.
- Parse at the boundary, once, into a branded type: `parseWipDir`, `parseVersion`,
  `parseProjectPath` grant `WipDir`, `Version`, `ProjectPath`. Past the parser: no `typeof`,
  no `as`, no re-check. A `ParseResult` is returned where the caller decides; anything else
  throws, and the route turns it into an answer.
- `src/core/protocol.ts` is the one place a value crossing HTTP or an extension boundary is
  typed; it re-exports the domain types it carries, never redefines them. What an extension
  hands the core is typed beside it, in `src/core/extension.ts`.
- `Review` binds the `ServerContext` of `src/core/extension.ts` to itself and to `fs.ts`, since
  it is `Review` that calls an extension's `holds` and `approved`; `http/serve.ts` hands the same
  context to each extension's routes and mounts them under `/api/x/<id>/`; `routes.ts` looks them
  up after its own, behind the same token check, and knows none by name.
- An extension may hold the review: `holds` answers what holds it, or `null`. Held has one
  meaning, so there is no list of what is blocked: `gate` is refused with the reason before
  `plan.md` is read (the 409 the module already reads), a feedback is refused, a drafting comment
  with it since it is a decision too, and an approval goes through. `ReviewView.held` carries the
  reason to the page. The core names no extension: it appends what a gate means to the reason.
- One queue orders every mutation: `gate`, `decide`, and an extension's writes through
  `ServerContext.inOrder`. A gate that checked the hold writes its version before a grill that
  opened meanwhile, never after. `holds` and `approved` run inside the queue and never call it.
- An approval closes what an extension left open on the server, through `approved`, after the
  rename and with the memory set, so `workspace().dir` is the final directory. No module has to
  be alive for it, and an extension that throws there leaves the plan approved.
- The module's heartbeat or a reviewer's tab keeps the server: the watchdog expires it once the
  last heartbeat is past the grace and no event stream is open. A tab holds it for a bounded
  time only (`tabHoldMs`): a `/clear` or a revive on another port leaves a server its module
  never beats again, and a tab still listening to it must not keep it for good. `routes.ts` counts the streams,
  since the review's own listeners include one `serve.ts` keeps for itself; the same count
  decides whether `POST /api/open` and a gate open the browser.
- `--token` and `--port` revive a server where its tabs expect it. A port taken meanwhile binds
  another one under a new token, never the kept one: the event stream's URL carries the token,
  so whoever took the port reads it from every tab that reconnects. `--existing` refuses a
  working directory that is gone (`WorkdirGone`, exit 3, relayed by the launcher) instead of
  creating it.
- A new domain concept gets its address in `domain/` before its first line.
- A version is a text somebody handed over for review, Claude through `gate` or the reviewer
  through a decision that carries an `Edit`. `decideOn` decides all of it, purely: the version
  the decision applies to, the version file to write, the comments retargeted to it, the notes
  file. An `Edit` names the version it edits, and one of another version is refused: a bare text
  sent after Claude recorded `vN+1` would overwrite that revision and tell Claude to keep it.
  `vN.md` stays what its author submitted.
- `Review.decide` applies in an order where a write that fails leaves a state the next `gate`
  or the next load repairs: `plan.md` before the edit's version file, the notes file and the
  draft's removal before the rename, which carries what is there. A `null` from `formatNotes`
  writes nothing and keeps a notes file already there: a retry after a failed rename carries no
  note. Whether the approval's prompt names a notes file is read from the final directory's
  listing, never from the decision.
- The draft is the page's, stored and never read back: `PUT /api/draft` parses it as it parses a
  decision's annotations and edit, `GET` returns the bytes. `saveDraft` writes one with content
  only where `takesComments` holds and answers 409 elsewhere, since a write would recreate a
  directory the approval has just renamed; an empty one removes the file in any state. A draft
  write raises no workspace event: `watchFiles` leaves `.review/` to the server.
