# Hook runtime behavior

[Plugin testing index](../plugin-testing.md). Read after the [hook test procedure](hooks.md) when engine behavior needs explanation. The [upstream cheat sheet](../function-hooks-cheat-sheet.md) is a separate verbatim reference.

## Module loader

- A hooks module may span several files, but `$` may not: the loader follows
  it only into a function declared in the file that registers the hook, and
  refuses a noun passed on its own (`$.store is used as a value`). Every other
  file takes a plain record of closures instead, bound where `$` is in scope
  (`vellum/src/core/engine/host.ts`, `mods/diff/hooks/host/host.ts`).

- `hooks/hooks.json` stays where it is, and the module it names does not have
  to: `"modules": ["../src/core/engine/register.ts"]` loads under
  `--plugin-dir`, `validate` and the kit. Not measured: that entry loaded from
  the copy an install puts in the cache.

- One hooks module per plugin. A second entry in `modules` is refused by
  `claude plugin validate` (`modules names one hooks module per plugin; a
  second entry is refused`), and `claude plugin test` then finds no module to
  load.

- One hook per event and matcher. A second `on("turn.complete", ...)` without
  a matcher keeps the module from loading: `on("turn.complete") is registered
  twice without a matcher`. So a plugin made of parts keeps each event's one
  hook in the registering file and calls the parts' handlers from it, each
  handed the record of closures; measured under `validate` and the kit with a
  handler imported from another directory of the plugin.

- `claude plugin validate` prints each matcher's **source text**, not its
  value: a matcher written `{ command: STOP.name }` is reported as
  `command.run{command=STOP.name}`. Write matchers as string literals. Two
  hooks on one event are two entries, each with its own matcher.

## Failures and file access

- A hook that throws or overruns is skipped, and what is beneath it runs in
  its place. For a `tool.check` hook that is a lock, that is fail-open: the
  write the hook meant to refuse goes through on the engine's own verdict.
  `on(...).catch(($, e, next) => ...)` on the registration is how such a hook
  fails closed; `next.error.kind` says `throw` or `timeout`, and
  `claude plugin validate` lists the hook without saying a handler is there.

- `$.fs.stat` rejects a missing path with a `HooksError` whose message ends
  on the errno, `<plugin>: $.fs.stat(<path>) failed: ENOENT`, and sets no
  `code`. Any other OS refusal ends on its own errno (`ENOTDIR`, `EACCES`,
  `ELOOP`), a network path is refused as `fs.stat: a network location is not
  reached from here (host check)`, and a hook's deny reads
  `<plugin>: $.fs.stat: <reason>`. Only the `failed: ENOENT` ending therefore
  says a path is not there (`vellum/src/core/engine/place.ts`). A link that
  leads nowhere resolves, with `isLink` and no `realPath`. Measured on Linux
  in a live session: in the kit nothing beneath the plugins answers
  `fs.stat`, and a test answers it with `on("fs.stat", ...)`.

## Reloads and background work

- Saving a file under `--plugin-dir` reloads the module: `register` runs
  again in a fresh environment and every pending timer of the old one dies.
  State the module must keep across a reload goes to `$.store`. The transcript
  says the reload landed, `<name>: reloaded (5 hooks: session.start,
  skill.prompt, command.run, tool.check, tool.call)`, counting distinct events,
  so two hooks on one event read as one.

- A hook answers within its dispatch's budget, about ten seconds. What must
  wait for a person (a browser decision) is polled by `$.clock.every` and
  handed to the session by `$.prompt.submit`, which runs once the session is
  idle. The prompt shows as `Prompt from the <plugin> plugin`, framed by
  Claude Code as a message to address; a text that points at a file the
  session can read works (`spike-results.md` in
  `plans/2026-09-15/plan-review-rewrite/`).

- `$.process.run` reads the whole output, so a server started from a hook
  must be spawned detached by a launcher that relays one line and exits.
  Nothing tells a detached process that the session ended: give it a
  heartbeat from `$.clock.every` and let it exit when the beat stops.

- Saving a file under `--plugin-dir` prints `<plugin>: reloaded (N hooks: …)`
  and raises `session.start` again for that plugin alone, so a mode kept in
  `$.store` can be restored there. Registering the same tool or command name
  again replaces it, with no warning and no duplicate in the typeahead.

## Tools, commands and modes

- A plugin can hold a mode of its own instead of borrowing a native one. The
  three pieces, measured together (`spike-results.md` facts 13 to 20): a
  `tool.check` hook as the lock, a `$.tool.register` tool as the model's
  explicit signal, a skill as the way out. Each is an engine event or a server
  answer, so nothing rides on the model remembering to call something.

- A `tool.check` deny from a module reaches the model as
  `Permission to use <Tool> denied by plugin <name>: <reason>`, in `default`
  mode and in `auto` mode alike; a hook's deny is not overridden by the mode.
  Returning `next(e)` instead leaves the session's own mode to decide, so a
  write a plugin means to allow still prompts in `default`: answer
  `{ decision: "allow" }` for the paths the plugin owns.

- `next(e)` there carries `rule` when a settings allow rule decided
  (`{"decision":"allow","rule":"Bash(mkdir:*)"}`), and leaves it out when the
  mode or the tool's own check did. That is how a plugin tells a user's
  standing grant from the engine's own verdict.

- `$.command.register({ name: "stop" })` is listed as `/stop`, with no plugin
  prefix; only skills and markdown commands get `/<plugin>:<name>`. Its
  `{ text }` prints under the plugin's name and starts no model turn. A way in
  or out that must stay in the plugin's namespace is a skill instead, with
  `disable-model-invocation: true` so only the person runs it, closed on the
  plugin's own `skill.prompt` hook.

- A `tool.call` hook with no matcher breaks worktree isolation, in every
  session where its plugin is enabled, from the module's load. It wraps every
  tool call of every agent, and a subagent spawned with `isolation: worktree`
  runs its Bash inside the hook's `next(e)`, where the engine loses the agent's
  working directory: each call is refused ("The working-directory isolation
  context for this agent was lost"), and the debug log reads `[worktree]
  blocked shell exec after cwd-override loss`. A module whose one hook is
  `on("tool.call", ($, e, next) => next(e))` is enough; the same session
  without it runs the agent's `pwd` under `.claude/worktrees/agent-…`. A
  matcher that lists the plugin's tools as strings leaves isolation whole, and
  so does an unmatched `tool.check` hook. A RegExp in that list does not: the
  kit honours it, but a live session ran the hook for every tool call.
  Measured in `claude -p` sessions, one isolated subagent running `pwd`.

- A registered tool's result text is what the model acts on:
  `Plan vN is under review in the browser. End your turn; the review arrives
  as a prompt.` ended Opus 5's turn every time. `vellum` now answers the
  shorter `Plan vN under review. End your turn.`, whose effect on the turn is
  not measured in a live session yet.

## Drawing

- A `Link` whose `href` is neither `https:` nor `http://localhost` refuses
  the whole tree it is in: `$.ui.mount` in the kit rejects with
  `<plugin>: ui.render (AbovePrompt) refused: Link href must be https: (or
  http://localhost); the engine drew its own`, for `http://127.0.0.1:<port>/`
  and `http://example.com/` alike, while `http://localhost:<port>/` and
  `https://example.com/` draw. A page served on 127.0.0.1 is linked through
  `localhost`: curl and a headless Chromium try `::1`, are refused, fall back
  to 127.0.0.1 and load it, API calls included (measured on Linux, whose
  `/etc/hosts` maps `localhost` to both). How a real terminal draws the link
  is not measured here.

- The kit draws `ui.render`: `$.ui.mount({ plugin, surface, component, props })`
  holds the drawing, and `find` hands each element with `text`, every string
  beneath it in order, a `Link`'s label included. A drawing mounted before a
  change is drawn again when the plugin calls `$.ui.invalidate("ui.render")`,
  from a timer the test's `mock.clock` fires too, and keeps its old tree
  without the call. A hook that passes to `next(e)` finds nothing beneath in
  the kit (`no implementation for ui.render`), so a test answers the site
  with its own `on("ui.render", ...)` (`vellum/src/core/engine/fixtures/band.ts`).

## What the contract and the docs say

Read from `vellum/types/claude-code.d.ts` (symbol names below) and from the
official docs (page § section). Neither is measured in a session; each is
what the engine's own text commits to. Function hooks are early access and
absent from the public docs: the `.d.ts` is their only reference.

- `tool.check` (`ToolCheckInput`, `ToolCheckDecision`) fires when the engine
  decides whether a call may run, after `tool.call` and `PreToolUse`.
  `next(e)` is the engine's own verdict `{ decision, reason?, rule? }`; a hook
  may return any `allow | ask | deny`, and the last word up the chain wins.
  `deny`'s `reason` is what the model reads. Its input has no agent id: it
  fires for subagents too.
- `$.tool.register` (`ToolSpec`) declares `mcp__<plugin>__<name>`; a
  `tool.call` hook on that name serves it by returning `{ result }` without
  `next`, and a call no hook answers fails. An unmatched `tool.call` hook that
  compares `e.tool` serves it as well (measured in the kit, `claude plugin
  test`), but breaks worktree isolation (§ Tools, commands and modes): list
  the names in a matcher instead. `$.command.register`
  (`CommandSpec`) declares `/<name>`, served by a `command.run` hook returning
  `{ text }`. Both reject until `session.start`, whose first raise is awaited,
  so registering there lists them by turn one (`'session.start'`). `/clear`
  does not raise `session.start` again.
- `$.prompt.submit` (`PromptSubmitInput`, `PromptSubmitResult`) runs when the
  session is idle; its promise resolves once the prompt entered or was queued
  behind the running turn, not when it is delivered. A prompt queued mid-turn
  lands at the next idle, however far away.
- A hook's budget is about ten seconds of real time (`Mock.clock`); the
  engine skips a hook that overruns it and runs what is beneath in its place.
- Bash's built-in read-only set runs without a prompt "in every mode"
  (permissions § Read-only commands), and plan mode adds nothing for Bash:
  commands outside the set go through the session's regular permission flow
  (permission-modes § plan mode). What plan mode changes is file edits:
  "never auto-approved, even when an allow rule matches", and file-modifying
  shell commands such as `touch` and `rm` too (agent-sdk permissions § Plan
  mode).
- `Stop` hooks "don't fire on user interrupts" (hooks-guide § Limitations).
  Interrupting while a hook callback is pending cancels the pending tool call
  (agent-sdk hooks § Hook timeout). A command hook that outlives the answer
  the user gave in the terminal keeps running until its own timeout
  (`spike-results.md`).
