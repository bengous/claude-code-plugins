# Vellum: the map, and where it goes next

For the people who change the tree. The tree itself is drawn once, in
[`AGENTS.md`](../AGENTS.md) § Shape; the rules an agent holds to are in
[`.claude/rules/`](../.claude/rules/), one file per zone (engine, server, page, extensions, tests), each
naming its own files. This file draws what those texts describe, names the shape and the
shapes left aside, shows where each part of a feature goes, and where extensions go next.

## Three runtimes, one contract

```mermaid
flowchart LR
  subgraph engine["Claude Code (the engine)"]
    CC["the session<br/>/vellum:start · mcp__vellum__submit · mcp__vellum__grill_* · /vellum:stop"]
    M["src/core/engine/<br/>register.ts · mode.ts: idle · live"]
    E["src/extensions/*/engine.ts<br/>grill: tools, refusals, staged"]
    CC -- "session.start · skill.prompt · command.run<br/>tool.check · tool.call · prompt.submit · turn.complete" --> M
    M -- "$.prompt.submit<br/>deny / result / text" --> CC
    M -- "every event, a Host, never $" --> E
  end
  subgraph server["vellum serve (one Bun process per session)"]
    R["src/core/server/adapters/http/routes.ts<br/>token, status codes"]
    A["src/core/server/app/review.ts<br/>read → decide → apply"]
    T["src/core/server/domain/*<br/>pure: states, decisions, paths, feedback text"]
    W["src/core/server/adapters/fs.ts<br/>plans/&lt;date&gt;/wip-&lt;sid8&gt;/"]
    R --> A --> T
    A --> W
  end
  subgraph page["Browser page (Preact, bundled by Bun.serve)"]
    U["src/core/page/*<br/>list · decision bar · comments · anchoring"]
    P["src/extensions/*/page.tsx<br/>markdown · html · image · grill"]
    U --> P
  end
  M -- "HTTP /api/*<br/>x-vellum-token" --> R
  A -- "stdout, one ServerLine a line<br/>ready · channel · stage" --> M
  U -- "HTTP /api/*, /t/&lt;token&gt;/files, SSE" --> R
  A -. "src/extensions/*/server.ts<br/>linkedDocs, pure" .-> A
  R -. "src/extensions/*/server.ts<br/>routes under /api/x/&lt;id&gt;/, IO through ServerContext" .-> W
  F[("plans/&lt;date&gt;/wip-&lt;sid8&gt;/<br/>plan.md, grill-&lt;n&gt;.md, .review/vN.md,<br/>vN.feedback-k.md, vN.notes.md, draft.json, channel.jsonl")]
  W --> F
```

`src/core/protocol.ts` is the one contract the three share: every value that crosses HTTP or
an extension boundary is typed there and is JSON. What an extension hands the core is typed
beside it, in `src/core/extension.ts`, and what crosses an extension's own routes in its
`protocol.ts`: § Extensions.

## What kind of architecture this is

**Hexagonal with a functional core**: two hexagons and one page, with the renderers as
feature slices. Ports and adapters give the direction (everything points at the domain,
the domain does no IO); "functional core, imperative shell" gives the weight (the domain
is functions over immutable data, one application module orchestrates, the adapters are
plain modules with no interface and no injection).

| Part | Shape | Driving side | Driven side |
|---|---|---|---|
| Hooks module | ports and adapters, `Host` the port | the engine's events (`session.start`, `skill.prompt`, `command.run`, `tool.check`, `tool.call`, `prompt.submit`, `turn.complete`), and the lines its server writes on stdout | the engine's `$` (clock, store, http, process, prompt, tool), answered by the kit in tests |
| Server | ports and adapters, domain / app / adapters | `adapters/http/routes.ts` | the file system through `adapters/fs.ts`, real in tests (a temp directory) |
| Page | a store of signals and components | the reviewer's clicks | `/api`, the files route, SSE |
| `src/extensions/<id>/` | feature slices: one extension = one folder, a half per runtime it plugs into | | |

Four levels of ceremony exist for the same principle; this is the lightest. The next one
up, ports as interfaces with a fake each and a contract test per port, is one hour away
the day a second file-system adapter exists: extract the port from `adapters/fs.ts`, hand
it to `app/review.ts`. The ones above (a use case object per intention, then aggregates
and repositories) answer needs this plugin does not have.

Two other shapes were weighed and left:

- **Folders by kind of code, the IO moved out** (a `server/fs.ts` beside the parsing).
  Cheaper by an hour; leaves the domain types in the HTTP contract and the next feature asking
  where its pure part goes.
- **Vertical slices by feature** (`gate/`, `decision/`, `finalize/`, `docs/`). Wrong here:
  the features share one state machine and one directory layout; slicing them splits the
  union across folders, and the first review's bugs were exactly cross-feature state.

Also weighed and left, for now:

- File and function length thresholds: the pedantic oxlint and the anti-slop pack are the
  mechanical backstop.
- Ports as interfaces with a fake each: `adapters/fs.ts` has one implementation and the file
  system is fast; the port is extracted the day a second one exists.
- A contract test between the fake `$` and the engine: `claude plugin test` runs in the
  engine's environment, and `bun test` at the repository root fails on its import.

## A review round

```mermaid
sequenceDiagram
  participant CC as Claude Code
  participant M as hooks module
  participant S as vellum serve
  participant B as page
  CC->>M: skill.prompt vellum:start
  M->>S: $.process.spawn cli.ts serve, POST /api/open
  S-->>M: stdout: ready, then the stage; GET /api/channel reads what is not relayed yet
  S-->>B: the page opens on the working directory's files
  M-->>CC: skill text + "Working directory: plans/<date>/wip-<sid8>/"
  loop every tool call while live
    CC->>M: tool.check → allow inside the working directory, deny outside it
  end
  CC->>M: turn.complete (the main loop answered), or tool.call mcp__vellum__submit
  M->>S: POST /api/gate → reads plan.md, writes .review/vN.md, opens the browser once; an unchanged text is kept
  M-->>CC: the tool's result: "End your turn."
  B->>S: PUT /api/draft (the unsent comments, edit and typing, at every change, and once more before a Send)
  B->>S: POST /api/send (what the reviewer saw at the click: comment ids, the edit, the parts) | POST /api/decision (approve, with the reviewer's edit or none)
  S->>S: a Send writes .review/vN.feedback-k.md from the draft it keeps, what it named, the stage unchanged; an edit is vN+1 first
  S->>S: approve → plan.md, the notes file, links rewritten, directory renamed
  S->>S: appends the entry to .review/channel.jsonl: sent (the batch) | approved
  S-->>B: SSE workspace
  S-->>M: stdout: the entry, then the stage
  M->>CC: $.prompt.submit ("Reviewer sent: read <path>." | "Plan vN approved, at <dir>. Read <notes file> first.")
```

## A grill

```mermaid
sequenceDiagram
  participant C as Claude
  participant M as hooks module
  participant S as vellum serve
  participant P as page
  C->>M: tool.call grill_suggest {subject, reason}
  M->>S: POST /api/x/grill/suggest, the slot pending under a new id
  S-->>P: workspace event, the modal over the page, or the Grill button's dot under a typing
  opt the reviewer declines it instead
    P->>S: POST /api/x/grill/decline {id}, the slot declined, the decline on the channel
    S-->>M: stdout: the entry
    M->>C: $.prompt.submit ("The reviewer declined the grill on: <subject>.")
  end
  P->>S: POST /api/x/grill/open {subject}
  S->>S: writes grill-1.md, its header, and the opening on the channel
  S-->>M: stdout: the entry
  M->>C: $.prompt.submit (the opening)
  C->>M: tool.call grill_ask {q}
  M->>S: POST /api/x/grill/ask, a round opened, then POST wait, held under 30 s, again and again
  P->>S: POST /api/send (the bar's, parts included): the grill's part reads the reply, writing nothing
  S->>S: the batch vN.feedback-k.md, Grill then Comments; its sent entry; the grill's commit answers the wait, then writes the reply in the round
  S-->>M: stdout: the entry, held by the follower while grill_ask waits
  S-->>M: the wait's answer: the entry's number and "Reviewer: ..."
  M->>C: the tool's result; the follower never relays that entry
  C->>M: turn.complete
  M->>S: POST /api/x/grill/answer {text, reason, own, asked}, the turn's text after the reply
  P->>S: POST /api/x/grill/close, with what the draft holds as the reply, or the module's on /vellum:stop
  P->>S: POST /api/decision approve, the server ends the grill after the rename (approved)
  M->>C: $.prompt.submit ("The reviewer ended grill-1.md.", told for a close from the page alone)
```

A round is Claude's: `grill_ask` alone opens one, and the reviewer's reply is written in it, so
an answer is read beside its question. The reply leaves with the page's one Send, beside the
comments, as the batch's Grill section; it closes every open question, the ones the reviewer
left untouched with "As recommended, by default.", where "As recommended." is the
recommendation chosen, and the page asks before it takes one by default; so does the end of
the grill, which asks nothing. `grill_ask` waits for that Send and returns the reply as its
result, a `POST wait` at a time on the server, each under the engine's 30 s cut; Escape, or a
wait that fails, ends the call, and the batch reaches Claude through the channel as any other
("Reviewer sent: read <file>."). A question is open until a
reply answers it, whatever happened since: a command of the session (`/vellum:start`, `/clear`)
is the harness's, written as an event line that opens and closes nothing. What the reviewer
types in the terminal, and what Claude answers to it, are not the grill's and are not written.

The file is the transcript and the state: the server writes every round, the module writes
nothing, and what is open and who speaks next are read off `grill-<n>.md`
(`extensions/grill/transcript.ts`). What Claude hears is the core's channel and the waiting
tool's result: a Send's reply goes in its batch; any other write the reviewer causes appends,
as text the server words, the entries it added to the transcript, which `relaysOf` reads in
file order: the opening, the reply End grill writes, the end when the footer says `page`. So
nothing Claude says cancels one; a block written into the file by hand was there before the
write and is not told. The file serves the human,
the prompt serves the agent, and they no longer share a text: a prompt names its object
(`grill-2.md`) and repeats nothing Claude wrote or read. A reply goes under `Reviewer:`, the
note first, then the typed answers, never a default; `grilling.md` is named at the first grill
of the working directory alone; the end names the file. Every relay keeps the plugin's origin:
the lock lets Claude write in the working directory, the channel included, so an entry proves
no human wrote it, and it must never reach Claude as the user's own words.

The proposal alone lives in the server's memory, in one slot: `grill_suggest` fills it under a
random id, a decline from the page turns it declined and tells Claude the fact on the channel,
"The reviewer declined the grill on: <subject>.", a new proposal replaces either, and opening a
grill empties it.

Claude's final text is written when its turn is the grill's own: `prompt.submit` notes the
last prompt that entered and its origin, `turn.start`, which carries no origin itself, takes
that note when its text holds the noted one, and `turn.complete` hands `own` to the transcript
(`core/engine/turn.ts`, pure). A turn the terminal
started writes nothing, whatever the file's last voice is; the turn that asked a round closes it
either way, `asked` in the post: the grill's engine half marks the turn whose `grill_ask` the
server took, so its text goes with the round, before a reply the reviewer sent meanwhile, which
still waits for Claude. The file also says where the grill stands, `phaseOf`: `asking` while a
question is open, `working` while the reviewer spoke last, then `idle` or `stopped` by how
Claude's last turn ended, `_(turn aborted)_` and the like written by the server. While a grill is open the band above the prompt says `grill · open`: a
prompt typed in the terminal is outside the grill. A prompt Vellum itself submits comes back through its own `prompt.submit` hook, since
`$.prompt.submit` skips the calling hook alone; its origin (`plugin`, `vellum`) keeps it out of
the transcript, where the server already wrote what it carries.

## The two state machines

The hooks module, in memory, one union:

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> live: skill.prompt, server reached
  idle --> live: session.start, the stored server relaunched
  live --> live: another session id, server restarted
  live --> live: its server ended, revived on its port and token
  live --> lost: the revival failed, the working directory is gone, or its servers ended 3 times within 60 s
  idle --> lost: session.start or skill.prompt, the stored server not relaunched
  lost --> live: the slow retry, or skill.prompt, revived it
  lost --> idle: skill.prompt vellum:stop, command.run clear
  live --> idle: approval prompt entered
  live --> idle: skill.prompt vellum:stop
  live --> idle: command.run clear, or resume to another session
  idle --> idle: nothing starts
```

`lost` keeps the lock and the session with no server behind them: a failure never opens the
repository. `live` allows the file tools inside the working directory and denies them under the project
outside it, serves
`mcp__vellum__submit`, and reads its server's stdout until it closes: each entry of the channel
relayed as a prompt, once and in order, and each stage drawn in the band.

The server, derived from the directory plus a memory overlay
(`src/core/server/domain/workspace.ts`, `workspaceOf`):

```mermaid
stateDiagram-v2
  [*] --> drafting: wip-<sid8>/, no vN.md
  drafting --> drafting: a Send, v0.feedback-<k>.md written, batches + 1
  drafting --> inReview: plan.md gated, vN.md written
  inReview --> inReview: a Send, vN.feedback-<k>.md written, batches + 1
  inReview --> inReview: a Send with the reviewer's edit, vN+1.md and vN+1.feedback-1.md written
  inReview --> inReview: plan.md gated, vN+1.md written, batches 0
  inReview --> approved: Approve, links rewritten, renamed (memory)
  inReview --> inReview: rename failed, finalizeError (memory)
  inReview --> inReview: Retry approval
```

A Send locks nothing: the reviewer goes on commenting on the version, and each Send is the next
batch of it. A version has an author: Claude through `gate`, or the reviewer, whose edit a Send
or an approval records as `vN+1` before it applies to it. The edit names the version it was made
on, and `sendOn` and `decideOn` refuse one made on another. A gate after a batch records a new
version even with the same text, as the explicit `submit` means it.

What the hooks module relays is not read off that state: each Send and the approval append their
entry to the channel as they land (`domain/channel.ts`), `sent` naming the batch, `approved` the
final directory and the notes file when its listing holds one. The module
keeps one number of its own, in `$.store`: the last entry it relayed, under the channel's identity
(`.review/channel.id`, which the rename carries), so a reload never repeats one and a new working
directory at the same path starts from its first. The mode owns its server: leaving `live` ends
it, and so does a revival replacing it.

## Where the parts of a feature go

| Feature | Pure part | Adapter part | Page part |
|---|---|---|---|
| Comment on an HTML element | `ElementRef`, its `ElementDescription`, the `Anchor` variant `element` and its line in the feedback text (`describeElement`); `extensions/html/pick.ts`, `extensions/html/describe.ts` and `page/selection.ts` | `frame.js` built once at `startServer` and injected into `text/html` responses, `postMessage` across the sandbox | the HTML renderer bridges the frame and opens the Composer over the iframe |
| Coloured code and Mermaid | `rehype-highlight` in the `toTree` pipeline, so the hast keeps `data-lines`; the target kind `diagram` and `diagramPassage` in `extensions/markdown/pinpoint.ts` | | the Markdown renderer turns a `mermaid` block into a `figure`, draws it after the mount, and boxes it where text is highlighted |
| Diff `vN-1` / `vN` | `domain/diff.ts`: `lineDiff` over the `diff` package, `countChanges`; `extensions/markdown/changes.ts`: which block carries a mark, where a removed run goes | `/api/review` returns the previous version's text | `planChanges` computed once; the count beside the version, the "Changes since" toggle, the marks and the text-free removed blocks in the Markdown renderer |
| Delete marks and quick labels | `Mark` on `Annotation`, `QUICK_LABELS` with the sentence Claude reads, in `domain/feedback.ts` | `parseMark` in the draft's parser, `adapters/draft.ts` | the Composer's label row and "Delete this", the card's chip and struck quote |
| Direct edit | `Edit`, `sendOn` and `decideOn` (the edit is `vN+1`, refused on another version), `editOnLoad`, `landedAnnotations` in `domain/review.ts`; `shiftLines`, `shiftAnnotations` in `domain/diff.ts` | `parseEdit` in `adapters/draft.ts`; `Review.send` and `Review.decide` write `plan.md`, then the version file | `page/editor.tsx` and `page/caret.ts`; `edited`, `editing`, `finishEdit`, `settleEdit` in `state.ts` |
| Approval notes | `formatNotes`, `notesFile`, `approved.notes` read off the final directory's listing, the channel's `approved` entry and its `notes` | the notes file written before the rename; `engine/relay.ts` names it in the approval's prompt | the decision bar's one popover state: notes, and the warning before unsent comments are discarded |
| Drafts | `Draft`, `DRAFT_FILE`, `takesComments` | `GET` and `PUT /api/draft`, through the one parser of `adapters/draft.ts`; read back by a Send and by End grill; what a Send took leaves it, an approval removes it | `start`: restore, load, then save at every change, in order; `writeDraft` before a Send |
| One Send | `sendOn`, `batchFile`, `formatBatch`: what the Send names or its refusal, the extensions' parts, then the comments | `POST /api/send`, `Review.send` in one step of the queue: `sendOn` and each `part`, nothing written; the edit, the batch, the `sent` entry; the draft's rest, each part's `commit` | the bar's `Send (n)` and its warning, a card's Send now, `PageExtension.send`: a snapshot at the click, taken out of the page once sent |

Every one added a pure part first; `src/core/server/domain/` is where a new domain concept
goes, and a renderer's own choice stays beside its `page.tsx`.

## Extensions

`markdown`, `html`, `image` and `grill` are extensions, and so is whatever comes next
(`advisor`): a folder under `src/extensions/`, with one file per place where it plugs into the
core. The contract's client is the next agent that writes one, not a third party; the engine
constraints below are why. The contract is `src/core/extension.ts`, types only, and
`src/core/engine/extension.ts` for the engine half, types only, and the three registries are
`src/extensions/page.ts`, `server.ts` and `engine.ts`: read them rather than a copy here.

| Half | File | Declares | Reached from |
|---|---|---|---|
| page | `<id>/page.tsx` | a `PageExtension`: its renderers, tried in registry order, its actions in the decision bar, its notices under it, its panel, a pane `panesOf` places beside the document pane, and its share of the Send | `core/page/app.tsx`, through `extensions/page.ts` |
| server | `<id>/server.ts` | a `ServerExtension`: `linkedDocs`, pure, candidates in and links out; its routes, mounted at `/api/x/<id>/`, their IO through a `ServerContext`, what they tell Claude through its `relay`; `holds`, what holds the review; `approved`, what it closes after the rename; `part`, its part of the bar's Send and its `commit` | `core/server/adapters/http/serve.ts`, through `extensions/server.ts` |
| engine | `<id>/engine.ts` | an `EngineExtension`: tools, a tool's wait for the reviewer and the entries it returns, refusals, and handlers for a prompt, a finished turn, a `stage` line and the mode's end | `core/engine/register.ts`, through `extensions/engine.ts` |

`src/boundaries.spec.ts` holds the layout: an extension imports `core/` and its own folder,
never another extension; the core reaches the extensions from those three files alone; an
engine half loads its own folder and nothing else; from
`core/page/` an extension imports the files of `PAGE_SURFACE`, the list found when the rule was
written, and no other; every folder holds a half, a half's `id` is its folder's name, and its
registry names it. One exception is left, marked TODO in `serve.ts`: the server builds
`extensions/html/frame.ts` by its path, because a server half cannot hand the core a script
yet.

### What the engine allows

Claude Code takes one hooks module per plugin and one hook per event and matcher in it, so an extension
never calls `on(...)`: `core/engine/register.ts` keeps every event and calls the extensions'
handlers, imported by value through `../../extensions/engine.ts`, each handed a `Host`. A
hook of vellum's targets vellum's own tools: a hook with no matcher applies to every agent of
the session, and an unmatched `tool.call` hook takes the working directory from every
worktree-isolated agent's shell. So the extensions' tools and refusals go through one
`tool.call` hook whose matcher lists them, a literal written in `register.ts` as a matcher must
be, held equal to the registry by `register.spec.ts`; the hook dispatches on `e.tool`. The engine rule of
`boundaries.spec.ts` allows siblings alone, and that one registry for `register.ts`. No module path may leave the plugin, so no third party ever has an
engine half: no dynamic loading, no versioned API. The measurements, which hold for every
plugin: [Hook tests](../../docs/plugin-testing/hooks.md).

### Config: not designed yet

Two facts from Claude Code's docs shape it. Skills and agents load with the plugin, so a Vellum
config cannot hide one per repository; the module can only refuse it at `skill.prompt`. And
`userConfig` values live in the user's settings, project entries ignored, so a per-repository
config is a file of Vellum's own.

Nothing below exists yet, and `grill` does without it: an option or a flag is added when
someone asks to turn it. `grill` is the first that will: `enabled: false` there means no tool
registered, no route, no action, no renderer, and step 2 of the `start` skill names
`grill_suggest`, so whether the module adds that paragraph at `skill.prompt` only when `grill`
is on is the question left open. The design to revisit with what `grill` taught is `extension-contract.md` in
`plans/2026-09-17/extensions-de-vellum-arbre-noms-et-garde-fous/`; in short:

- A fourth file, `<id>/manifest.ts`: `id`, `required`, and the options as data (`boolean`,
  `number`, `text`, `choice`, each with its default). Pure, and the one file all three runtimes
  import. `definePage` and `defineServer` hand a half its options already typed; an extension
  writes no validation.
- Three layers, merged key by key, the last one winning: `~/.claude/vellum.json`,
  `.claude/vellum.json` (committed), `.claude/vellum.local.json` (git-ignored). With no file,
  every default applies. `enabled` is the core's key, never an option.
- `resolveConfig(manifests, layers)` refuses, naming the file, the key and what it expected:
  an unknown extension or option, a wrong kind, a number out of bounds, a choice outside its
  list, `enabled: false` on a required extension. The server reads the files when it starts
  and refuses to start on an error; the page and the engine get the resolved config from the
  server, and nothing else reads the files.

The crossroads a feature used to edit, and the place `grill` opened for each:

| Crossroads | Place opened |
|---|---|
| `core/server/adapters/http/routes.ts` | `ServerExtension.routes`, mounted under `/api/x/<id>/` behind the token |
| `core/page/app.tsx`, `core/page/state.ts` | `PageExtension.actions`, drawn in the decision bar; `PageExtension.panel`, a pane beside the documents, in the order `PANE_ORDER` of `core/page/panes.ts` holds |
| `core/engine/register.ts` | `EngineExtension`: tools, refusals, prompted, answered, staged, closing |
| `core/protocol.ts` | an extension's messages live in its own `protocol.ts` |

Left as they were: the document list names a kind by its media type, so a transcript reads
"Markdown" there, and an extension's styles still go to `core/page/style.css`.

The target to check next: `advisor` fits in one folder plus three registry lines.

