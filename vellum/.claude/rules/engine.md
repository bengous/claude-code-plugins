---
paths:
  - "hooks/**"
  - "src/core/engine/**"
---

# The hooks module

`hooks/hooks.json` is what Claude Code reads, and it names `src/core/engine/register.ts`. Nine
files there, each importing `claude-code`, a sibling `./<name>.ts`, or `import type` from
`../protocol.ts`, and nothing else; `register.ts` alone also loads `../../extensions/engine.ts`,
the registry of the engine halves. Held by `src/boundaries.spec.ts`.

```
register.ts  the engine adapter: the one `let state`, one hook per event, and `hostOf`
host.ts      `Host`, the port: one member per `$` call, named for the call
mode.ts      the machine: State, Session, Live, and restore / connect / close
lock.ts      the policy: lockVerdict, checkVerdict; pure
turn.ts      whose turn runs: Turns, prompted / started / completed, ownOf; pure
relay.ts     what the poll says and what it remembers: prompts, Relayed, tick
server.ts    the review server's client: every route, the token header, the launcher
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
- A server that dies comes back where it was. `pending` throws `ServerDown` on a transport
  error or a status outside the contract, and nothing else counts: a prompt the engine dropped
  proves nothing about the server. The third `ServerDown` in a row asks `revive`, once;
  `session.start` and `/vellum:start` revive a stored server that no longer answers the same
  way. A revival is `start` with the kept port, the kept token and `--existing`, so the
  reviewer's tab reconnects by itself and a directory an approval renamed is never recreated
  empty. `register.ts` checks `state === from` before and after the launch: a `/clear`, a
  `/vellum:stop` or a new way in wins, and the server started for nothing exits alone.
- A revival that fails is `lost`, never `idle`: the lock opens outside the mode, so a failure
  must not hand Claude the repository. `lost` keeps the session, the lock reads it through
  `sessionOf` as it does while `live`, the status says why (`server lost, retrying`, or
  `working directory gone, run /vellum:stop`), a slow timer asks `revive` again, and
  `/vellum:stop` is the way out.
- `session.start` registers the tool `submit` (`mcp__vellum__submit`, the model's "the plan
  is written" signal), served by a `tool.call` hook that answers without `next`. Its matcher
  must be a string literal, or `claude plugin validate` prints the expression instead of the
  name.
- The way out is the skill `vellum:stop`, closed on its own `skill.prompt` hook, not
  `$.command.register`: a registered command takes the global namespace (`/stop`), and
  `disable-model-invocation` keeps this one the reviewer's to run. The hook appends its line
  to `next(e).text`, as the start skill appends the working directory and the page's link.
- The lock is a `tool.check` hook with no matcher: while `live`, `Edit`, `Write` and
  `NotebookEdit` under the working directory are allowed outright, whatever the session's
  permission mode, and under the project and outside the working directory are denied with the
  reason the model reads. A path outside the project is no change to the codebase, so it
  follows the session's own permission flow: the scratchpad passes there without a prompt, a
  home or system file still asks. Every other tool passes on.
  `lockVerdict` decides as a pure function, the hook applies.
- The lock fails closed. A hook that throws or overruns "is skipped and what is beneath it
  runs in its place", which for a lock means the write goes through, so the registration
  carries a `.catch`: while `live`, `lockFailed` denies either way, whether the failure landed
  before or after `next(e)`; while `idle` the hook only passed `next(e)` through, so the
  handler replays it and a failure beneath is not vellum's deny. The lock reads
  `$.session.cwd()` for `Edit`, `Write` and `NotebookEdit` alone, so a failure there never
  denies a read. `claude plugin validate` lists the hook but not its handler, so nothing but
  this rule says the handler is there.
- `/clear` and `/resume` suspend the mode, on `command.run` and after `next(e)`: timers stopped,
  status cleared, `session:<id>` kept, so a later `/resume` of that session finds its directory.
  `/clear` always mints a new session id; `/resume` suspends only when the id changed, since an
  Esc in the picker or the same session resumed leaves the conversation planning. It is the
  deterministic place, not a guess at what the session did. `/vellum:stop` stays the reviewer's
  explicit way out and drops the record; both are no-ops when the mode is already idle.
- The poll closes the mode from inside a tick through `settle`, which `register.ts` honours
  only while the state the tick entered is still the current one: an approval that lands
  during a new way in leaves the new mode and its timers alone.
- The turn's end submits: a `turn.complete` hook, after `next(e)`, gates `plan.md` while
  `live` when the main loop answered (`reason === "answer"`, no `agentId`), with
  `{ unchanged: "keep" }` so a text the page already shows opens no version, after a feedback
  included. A recorded version sets the status and one log line; a kept one, a refusal (no
  `plan.md` yet, the plan approved) and a server that does not answer say nothing. The explicit
  tool stays the model's mid-turn signal and records a new version after a feedback.
- Every transition is an engine event or an answer from the server, never a reflex of the
  model. What is under review lives on the server's disk; the module keeps no copy of it.
- Parse at the boundary, once: `tool_input`, `$.store` values and the server's JSON arrive as
  `unknown` and are parsed in `parse.ts`. Past it: no `typeof`, no `as`, no re-check. The
  brands (`SessionId`, `Token`, `ProjectDir`, `Workdir`) are minted there and nowhere else.
- The server's JSON is typed from the server's own types: `parse.ts` imports `Pending` and
  `GateAnswer` from `../protocol.ts` as types, and `Json<T>` strips the domain's brands,
  which the module reads but never grants. A field the server adds or renames fails `tsgo` in
  the parser.
- Saving the file under `--plugin-dir` reloads the module in a fresh environment and every
  pending timer dies: state that must survive a reload goes to `$.store`.
- A hook answers within its dispatch's budget, about ten seconds. What waits for a person is
  polled by `$.clock.every` and handed to the session by `$.prompt.submit`, which runs once
  the session is idle.
- One poll relays everything the reviewer sends: the drafting batches, then the decision. What
  was already named (the drafting count, the feedback version) goes to `$.store` under the
  working directory it belongs to, so nothing is said twice across a reload or a restarted
  server, and an approval drops the record: the next plan's batches count from one again.
  The approval's prompt says to read the reviewer's notes file first when the pending carries
  one; the module reads the path and never the file. Each of these prompts is the fact and its
  object, nothing else: the skill `start` already says what to do with a feedback, a drafting
  batch and an approval, so the prompt does not say it again.
- An extension never calls `on(...)`: the engine takes one hooks module per plugin and one
  unmatched hook per event. `register.ts` keeps every event and hands it to the engine halves in
  registry order, each with an `EngineContext` (`Host`, `Live`, its own routes on the server),
  never `$`. A half that throws is logged and the next one runs. Its tools are registered at
  `session.start` and served by the one unmatched `tool.call` hook, which dispatches on
  `e.tool`, since a matcher must be a literal written in `register.ts`; the same hook denies
  what a half `refuses` while `live`. The poll runs the halves' `tick` after its own relay,
  handed to `mode.ts` as `ticks` the way `settle` is. `closing` is `/vellum:stop` alone: an
  approval is closed on the server, by the extension's `approved`, so a suspended module leaves
  nothing open.
- The module keeps no copy of what holds the review. A gate the server refuses is the refusal
  it already reads: `submit` denies with the server's reason, and the turn's end says nothing.
- `turn.start` carries no origin (`TurnStartInput` is a text and a turn id), so whose turn it
  is comes from `prompt.submit`, through `turn.ts`: `prompt.submit` notes the last prompt that
  entered with its origin, before `next(e)`; `turn.start` takes the note, and the turn is
  vellum's own when its text holds the noted text of a vellum relay; `turn.complete` of that
  turn id hands `own` to the halves' `answered`. It is the one thing the module knows that the
  server does not, and it is not a variant of `State`: it says who started a turn, nothing
  about what is allowed. Two facts, the waiting note and the running turn, since a prompt may
  enter while a turn runs; each is a union of its own, never a nullable. `register.ts` resets
  it wherever the mode leaves `live` (approval, `/vellum:stop`, the `/clear` and `/resume`
  suspension, a revival) and ignores it outside `live`.
- Every miss of `turn.ts` falls on one side, a turn whose text is written nowhere: a reload
  between the hooks, a text a hook beneath rewrote, and the known one, a relay and a typed
  prompt that wait together, which leave one note, the last. It is one note and never a
  registry: a text identifies a prompt, not a submission. The match is `includes`, not
  equality, because how the engine frames a plugin's prompt in `turn.start`'s text is not
  measured; an empty note matches nothing.
- A text enters Claude's context only when Claude does something different because of it.
  Anything else goes to `$.ui.status`, `$.ui.log` or the page. A prompt names its object and
  repeats nothing Claude wrote or already read, and every relay keeps the plugin's origin.
- An extension's store records are keyed `<id>:<session id>`.
- Tests run under the engine's own `$` (`claude plugin test vellum`, the `*.test.ts` files beside the module):
  `bun test` cannot host that environment. The world beneath the module is answered by the
  kit's `mock.clock` and the `on(...)` hooks of `fixtures/`. Nothing else is faked.
