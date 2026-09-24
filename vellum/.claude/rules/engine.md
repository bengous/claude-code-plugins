---
paths:
  - "hooks/**"
  - "src/core/engine/**"
---

# The hooks module

`hooks/hooks.json` is what Claude Code reads, and it names `src/core/engine/register.ts`. The
files there each import `claude-code`, a sibling `./<name>.ts`, or `import type` from
`../protocol.ts`, and nothing else; `register.ts` alone also loads `../../extensions/engine.ts`,
the registry of the engine halves. Held by `src/boundaries.spec.ts`.

```
register.ts  the engine adapter: the one `let state`, one hook per event, and `hostOf`
host.ts      `Host`, the port: one member per `$` call, named for the call
mode.ts      the machine: State, Session, Live, and restore / connect / close
lock.ts      the policy: lockVerdict, checkVerdict; pure
place.ts     where a path lands: placed, landed; asks the host's `stat`
turn.ts      whose turn runs: Turns, prompted / started / completed, ownOf; pure
relay.ts     what the channel says and what it remembers: prompts, Relayed, follow, the waits' claims
band.ts      what the band above the prompt says: the plan's segment, then the extensions', then the link; pure
server.ts    the review server's client: every route, the token header, the launcher, the reader of its stdout
parse.ts     the boundary: unknown to types, and the only place a brand is minted
extension.ts `EngineExtension`, the contract an extension's `engine.ts` fills; types only
```

The module holds the vellum mode, a mode of its own: the native plan mode never enters the
loop. `/vellum:start` enters it, Approve in the page or `/vellum:stop` leaves it.

- `$` is spelled only in `register.ts`, and the other files take a `Host`. The loader
  refuses anything else: "$ is followed only into a function declared in this same file,
  never across an import; $ is always spelled $.noun.event(...) at the call site". Passing one
  noun is refused the same way ("$.store is used as a value"). `hostOf($)` is built inside
  each hook, so a timer keeps the host of the dispatch that started it.
- One `State` union (`idle | live | lost`), never several nullables. A new feature adds a
  variant, not a flag. Before writing `let x: T | null`, name the state `null` stands for.
- The server is a child of the module, `$.process.spawn` of `cli.ts serve`, and says everything
  on its stdout, one `ServerLine` per line: `ready` first, with its channel's identity, then each
  entry of the channel and each change of the review (`protocol.ts`). The engine's facts this
  rests on (pieces, not lines; about 1.6 MB unread blocks the child; never spawn from a
  `tool.call`; `return()` kills a child whose read is pending; a reload ends every child) are in
  [Hook runtime](../../../docs/plugin-testing/hook-runtime.md) § Reloads and background work. So
  `server.ts` keeps each piece's tail, the loop that reads the child hands each line on and
  awaits nothing else, and `start` waits `START_TIMEOUT_MS` for `ready`, then ends the child.
- The mode owns its server: a `Live` holds the child, and `become` ends it as the mode leaves
  that `Live` (`/vellum:stop`, `/clear`, `/resume` away, the approval, a way into another
  session, a revival replacing it); a launch nobody takes is ended too. A server that dies comes
  back where it was: its end while its mode is current asks `revive`, and so do
  `HEARTBEATS_MISSED` heartbeats left unanswered, the child ended first. A revival is `start`
  with the kept port, the kept token and `--existing`, and `--final` once an approval renamed the
  directory, so the reviewer's tab reconnects by itself and a directory is never recreated
  empty. `CRASHES_BEFORE_LOST` unexpected ends within `CRASH_WINDOW_MS` stop the revivals: the
  mode goes `lost`, its log naming the last end. A reload ends every child, and `session.start`
  relaunches the stored session the same way, leaving the mode of another session first. A
  server this module did not spawn cannot be read, so a kept one is never taken back: a port
  another process still holds gives the relaunched server another port under a new token, and
  the store keeps those. `register.ts` checks `state === from` before and after the launch: a
  `/clear`, a `/vellum:stop` or a new way in wins, and the server started for nothing is ended.
- A revival that fails is `lost`, never `idle`: the lock opens outside the mode, so a failure
  must not hand Claude the repository. `lost` keeps the session, the lock reads it through
  `sessionOf` as it does while `live`, the status says why (`server lost, retrying`, or
  `working directory gone, run /vellum:stop`), the band shrinks to the name and the link, a
  slow timer asks `revive` again, and `/vellum:stop` is the way out.
- `session.start` registers the tool `submit` (`mcp__vellum__submit`, the model's "the plan
  is written" signal), served by a `tool.call` hook that answers without `next`. Its matcher
  must be a string literal, or `claude plugin validate` prints the expression instead of the
  name.
- A hook of vellum's targets vellum's own tools. A hook with no matcher applies to every agent
  of the session, subagents included, from the module's load, whether the mode is live or not.
  An unmatched `tool.call` hook wraps every tool call, and a worktree-isolated agent's shell
  loses its working directory inside it ([Hook runtime](../../../docs/plugin-testing/hook-runtime.md)
  § Tools, commands and modes), so every `tool.call` hook names its tools, each as a string:
  a RegExp in the list runs the hook for every call in a live session, though the kit honours
  it. A built-in the generated contract lacks (`AskUserQuestion`) is written as a string under
  a `@ts-expect-error`, which fails the typecheck the day the contract names it. The lock is the one
  unmatched tool hook left: it must see every file tool, and a `tool.check` hook leaves
  isolation whole.
- The way out is the skill `vellum:stop`, closed on its own `skill.prompt` hook, not
  `$.command.register`: a registered command takes the global namespace (`/stop`), and
  `disable-model-invocation` keeps this one the reviewer's to run. The hook appends its line
  to `next(e).text`, as the start skill appends the working directory and the page's link.
- The lock is a `tool.check` hook with no matcher: while `live`, `Edit`, `Write` and
  `NotebookEdit` under the working directory are allowed outright, whatever the session's
  permission mode, and under the project and outside the working directory are denied with the
  reason the model reads. A path outside the project is no change to the codebase, so it
  follows the session's own permission flow: the scratchpad passes there without a prompt, a
  home or system file still asks. Every other tool passes on, but for one downgrade:
  `checkVerdict` turns an engine `allow` that carries a settings `rule` on a shell tool
  (`Bash`, `PowerShell`, `Monitor`, the set `SHELLS`) into `ask`; an allow the mode gives on
  its own, with no rule, stands.
  `lockVerdict` decides as a pure function, the hook applies.
- The lock compares where paths land, never how they are spelled. `placed` asks
  `$.fs.stat(path, { resolve: true })` for `realPath`, which the engine's types name the robust
  guard: every link followed, whatever separators, drive or prefix the platform writes. A file
  not written yet lands under the first of its folders that exists, and only `ENOENT` says a
  folder is missing; a path that lands nowhere known (a link that leads nowhere, a stat refused
  for any other reason, a network path, a name Windows reads as a drive) is denied, since the
  tool may still open it. The project is placed on each call, and its `realPath` says the
  platform: POSIX answers it from `/`, and there `\` is a character of a name. The working
  directory is the project's own, `workdir` as written under where the project lands: a link
  on the way to it, the directory itself included, leads out of it and allows nothing.
  `realPath` keeps a case alias as written, so the allow compares as written and the deny
  folds the case. A new platform case is a question for `stat`, not a spelling rule in
  `lock.ts`. Measured on Linux; what a Windows disk answers is not measured.
- The lock fails closed. A hook that throws or overruns "is skipped and what is beneath it
  runs in its place", which for a lock means the write goes through, so the registration
  carries a `.catch`: while `live`, `lockFailed` denies either way, whether the failure landed
  before or after `next(e)`; while `idle` the hook only passed `next(e)` through, so the
  handler replays it and a failure beneath is not vellum's deny. The lock reads
  `$.fs.stat` for `Edit`, `Write` and `NotebookEdit` alone, and `$.session.cwd()` for a
  relative path of theirs alone, so a failure there never denies a read. `claude plugin validate` lists the hook but not its handler, so nothing but
  this rule says the handler is there.
- `/clear` and `/resume` suspend the mode, on `command.run` and after `next(e)`: timers stopped,
  server ended, status cleared, band gone, `session:<id>` kept, so a later `/resume` of that
  session finds its directory and starts a server there.
  `/clear` always mints a new session id; `/resume` suspends only when the id changed, since an
  Esc in the picker or the same session resumed leaves the conversation planning. It is the
  deterministic place, not a guess at what the session did. `/vellum:stop` stays the reviewer's
  explicit way out and drops the record; both are no-ops when the mode is already idle.
- The relayed approval closes the mode through `settle`, which `register.ts` honours only while
  the mode holds that session, live or lost: an approval that lands after a way into another
  session leaves that mode alone. A closing that fails is retried at the heartbeat, and the
  approval is never told twice.
- The turn's end submits: a `turn.complete` hook, after `next(e)`, gates `plan.md` while
  `live` when the main loop answered (`reason === "answer"`, no `agentId`), with
  `{ unchanged: "keep" }` so a text the page already shows opens no version, after a feedback
  included. A recorded version writes one log line, and the band draws it from the next `stage` line; a kept one, a refusal (no
  `plan.md` yet, the plan approved) and a server that does not answer say nothing. The explicit
  tool stays the model's mid-turn signal and records a new version after a feedback.
- Every transition is an engine event or an answer from the server, never a reflex of the
  model. What is under review lives on the server's disk; the module keeps no copy of it.
- Parse at the boundary, once: `tool_input`, `$.store` values and the server's JSON arrive as
  `unknown` and are parsed in `parse.ts`. Past it: no `typeof`, no `as`, no re-check. The
  brands (`SessionId`, `Token`, `ProjectDir`, `Workdir`) are minted there and nowhere else.
- The server's JSON is typed from the server's own types: `parse.ts` imports `ChannelLine`,
  `ServerLine` and `GateAnswer` from `../protocol.ts` as types, and `Json<T>` strips the domain's brands,
  which the module reads but never grants. A field the server adds or renames fails `tsgo` in
  the parser.
- Saving the file under `--plugin-dir` reloads the module in a fresh environment: every
  pending timer dies, and every child it spawned. State that must survive a reload goes to
  `$.store`; the session's record and the relayed record are the two, and one of an older shape
  fails its parser and starts over.
- A hook answers within its dispatch's budget, about ten seconds. What waits for a person
  arrives on the server's stdout and is handed to the session by `$.prompt.submit`, which,
  called while a turn runs, resolves once that prompt's own turn starts: the relays run in a
  queue of their own, never in the loop that reads the child.
- A tool call may wait for the reviewer instead (`grill_ask`): it keeps one `$.http.fetch` in
  flight at all times, each held by the server under the engine's 30 s cut, so the budget never
  runs (a promise awaited alone overruns it). It says `waiting` on its `ToolContext`, and from
  then on the tenure's follower holds every entry its tool `awaits` (`claim` in `relay.ts`)
  until the call ends: an entry the call returned (`ToolAnswer.returns`, marked unless Escape
  aborted the call as it answered) is never relayed, and the others go once the call ended. The
  hold is what keeps one Send from reaching Claude twice: its line on stdout and the server's
  answer to the wait come by two paths, in either order. After Escape the call's `$` fail, its
  wait ends, and what it held goes through the channel.
- Everything the reviewer sends reaches Claude as an entry of the channel,
  `.review/channel.jsonl`, numbered by its line (`server.md`). One follower per session in a
  module's environment relays each entry once and in order (`follow` in `relay.ts`): it belongs to
  the mode's `Tenure`, carried across the servers a revival replaces, so a prompt still waiting
  for its turn is never relayed a second time, and it stops when the mode leaves. It writes the
  last number relayed to `$.store` under the channel's identity after each prompt, so nothing is
  said twice across a reload or a relaunched server, and a new working directory at the same
  path, another channel, is read from its first entry. A number past the next one reads the
  entries it missed from `GET /api/channel` first, as every way in does, and logs the numbers the
  channel holds no entry for; a dropped prompt stays due, and the heartbeat reads the channel
  again. The approval drops the record. A `stage` line that says approved keeps the final
  directory in the session's record before the approval reaches Claude: a server revived
  meanwhile starts there, and relays it. Each prompt is the fact and its
  object, nothing else: `Reviewer sent: read <file>.`, the approval with the notes file to read
  first when there is one (the module reads the path and never the file), an extension's text as
  it worded it. The skill `start` already says what to do with a file sent and an approval, so
  the prompt does not say it again.
- The mode's one place in the terminal is the band above the prompt: the `ui.render` hook on
  `AbovePrompt` draws `vellum │ <plan> │ <segments> │ Review page ↗` while the mode holds a
  session, and passes to `next(e)` while `idle` or while a survey holds the band
  (`hasSurvey`). `$.ui.status` is written for a failure alone, the two of `lost`, and entering
  `live` clears it. No `SessionMode` label: the band is the one place.
- Where the plan stands is the server's: a `stage` line carries the workspace, `parse.ts`
  reads its kind and version, and `register.ts` keeps the last one per `Live`, so a new way in
  draws none until its first `stage` line. An extension adds its own segment through `segment`,
  asked in registry order after the plan's; one that throws is left out and logged once per mode.
  Every write of `state` goes through `become`, which calls `redraw`, as each `stage` line does:
  `redraw` computes the band `ui.render` draws and calls `$.ui.invalidate("ui.render")` only when
  it changed. A draw computes nothing, so `segment` runs at a `stage` line or a transition.
- A line of the server's stdout the module does not read is logged, and an answer of
  `GET /api/channel` it does not read throws in `parseChannel`, the shape of another server
  version included: read as nothing, either would drop the reviewer's entries without a word.
- The link is `http://localhost:<port>/t/<token>/` (`pageUrl` in `server.ts`, which also
  builds the printed 127.0.0.1 address): a `Link` to `http://127.0.0.1` refuses the whole
  tree, and `localhost` reaches the server, which listens on 127.0.0.1 only ([Hook runtime](../../../docs/plugin-testing/hook-runtime.md) § Drawing).
- An extension never calls `on(...)`: the engine takes one hooks module per plugin and one
  unmatched hook per event. `register.ts` keeps every event and hands it to the engine halves in
  registry order, each with an `EngineContext` (`Host`, `Live`, its own routes on the server),
  never `$`. A half that throws is logged and the next one runs. Its tools are registered at
  `session.start` and served by the extensions' `tool.call` hook, which dispatches on
  `e.tool`; the same hook denies what a half `refuses` while `live`. That hook carries a
  `.catch`, since a `tool.call` hook that throws or overruns falls to the engine's permission
  prompt, then to "no tool.call hook answered": a call that failed while waiting answers
  `The reviewer's answer will arrive as a prompt`, any other a deny naming the failure. Its matcher is a literal
  written in `register.ts` that lists every half's tools and refusals, and `register.spec.ts`
  holds it equal to the registry, so a half's new tool fails that suite until the literal
  names it. Each `stage` line runs the halves' `staged`, handed to `mode.ts` as `staged` the
  way `settle` is. `closing` is `/vellum:stop` alone: an
  approval is closed on the server, by the extension's `approved`, so a suspended module leaves
  nothing open.
- The module keeps no copy of what holds the review. A gate the server refuses is the refusal
  it already reads: `submit` denies with the server's reason, and the turn's end says nothing.
- `turn.start` carries no origin (`TurnStartInput` is a text and a turn id), so whose turn it
  is comes from `prompt.submit`, through `turn.ts`: `prompt.submit` notes the last prompt that
  entered with its origin, before `next(e)`; `turn.start` takes the note, and the turn is
  vellum's own when its text holds the noted text of a vellum relay; `turn.complete` of that
  turn id hands `own` to the halves' `answered`. It is the core's one thing the module knows
  that the server does not, and it is not a variant of `State`: it says who started a turn,
  nothing about what is allowed. Two facts, the waiting note and the running turn, since a prompt may
  enter while a turn runs; each is a union of its own, never a nullable. `register.ts` resets
  it wherever the mode leaves `live` (approval, `/vellum:stop`, the `/clear` and `/resume`
  suspension, a revival) and ignores it outside `live`.
- An engine half may know a fact of the running turn the server cannot read off its file; it
  keeps it in memory, keyed by the mode's `Live`: `grill` marks the turn whose `grill_ask` the
  server took and no answer came back to (`askedIn`, a `WeakSet` in `grill/engine.ts`) and clears
  the mark at `answered`, which posts it as `asked`, so the text of a turn cut short is written
  with its round even after a reply the reviewer sent meanwhile; a turn the answer came back to
  (`repliedIn`) is the grill's own, its text written after the reply. A reload between the two
  loses the mark: the text then goes where a turn that asked nothing writes it.
- Every miss of `turn.ts` falls on one side, a turn whose text is written nowhere: a reload
  between the hooks, a text a hook beneath rewrote, and the known one, a relay and a typed
  prompt that wait together, which leave one note, the last. It is one note and never a
  registry: a text identifies a prompt, not a submission. The match is `includes`, not
  equality, because how the engine frames a plugin's prompt in `turn.start`'s text is not
  measured; an empty note matches nothing.
- A text enters Claude's context only when Claude does something different because of it.
  Anything else goes to the band, `$.ui.log` or the page. A prompt names its object and
  repeats nothing Claude wrote or already read, and every relay keeps the plugin's origin.
- A store record of the module's own, or an extension's keyed `<id>:<session id>`, one record per
  extension, fails its parser when it has an older shape and starts over; the key is the
  session's, so only a plugin updated in the middle of a session replays anything. No extension
  keeps one today: what it tells Claude goes through the core's channel.
- Tests run under the engine's own `$` (`claude plugin test vellum`, the `*.test.ts` files beside the module):
  `bun test` cannot host that environment. The world beneath the module is answered by the
  kit's `mock.clock` and the `on(...)` hooks of `fixtures/`. Nothing else is faked.
