# Claude Mods — the $ cheat sheet

> Source: https://github.com/anthropics/claude-code/issues/91870 (community update, Anthropic, 2026-09-09).
> Function hooks early access (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`); a snapshot of the API on that date.
> Text transcribed verbatim from the SVG attached to the issue; tables and headings are layout only.
> Where the sheet and the generated `claude-code.d.ts` disagree, the types win: Claude Code writes them from the installed binary (`docs/plugin-testing/hooks.md`).

PRIMITIVE: FUNCTION HOOK · PRODUCT: CLAUDE MOD · ANTHROPIC · 2026-09-09

A mod is a plugin with a hooks module. The primitive underneath is the function hook: one async function per event, composed as middleware.

## The hook

```ts
export function register(on) {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (e.command.includes("rm -rf /")) return { deny: "no" }
    const r = await next(e)                   // every hook beneath, then core
    return { ...r, text: redact(r.text) }     // refine on the way up
  })
  .catch(($, e, next) =>                      // it threw or overran
    next.called ? next(e) : { deny: next.error.kind })
}
```

- `$` the engine interface; every method on it is itself an event
- `e` a flat value; ids are pinned, payload is yours to rewrite

## next

| Form | Meaning |
|---|---|
| `next(e)` | every hook beneath you, then core; resolves with the result |
| return without next | answer in core's place: `{ deny }` on tool.call, or your own result |
| `next.trace` | after await: each lower link's plugin, tier, e, result, outcome |
| `next.origin` | `{ plugin, tier }` of the caller; `{ engine, core }` when the engine raised it |
| `next.event` | in a glob or `*` hook: which event this dispatch is |
| `next.is("tool.*", e)` | type predicate: narrows e (and the result) to the matching events |
| `next.to(e, "builtin")` | managed only: continue at a lower tier; narrows only |
| `next(e); next(e)` | zero or more times; each is a fresh dispatch beneath |
| `next.error` · `.called` | in `.catch`: `{ kind, message, budget }`; did you dispatch? `next(e)` replays |

## The chain · five tiers · authority decreases toward core

| prepend | user | append | builtin | core |
|---|---|---|---|---|
| org policy | what you install | org policy | ships in binary | the engine |

```ts
on("*", ($, e, next) => next.to(e, "builtin"))   // the product as shipped, in one line
```

One fold for every event: on the way down each link may refine e (append is last before the product), core answers by default, on the way up each link may refine the result (prepend is last before the engine acts). An org holds both ends.

## Rules of the road

| Rule | |
|---|---|
| spelling | `$` is always written `$.noun.verb(…)` literally; `on("event")` literally. the loader inventories both and refuses anything it cannot see. |
| identity | ids on e are pinned (tool, tool_use_id, agentId, origin, provider, trigger, keys); the rest is yours to rewrite. |
| failure | a throw or a 10 s overrun skips the hook with one dim line, unless it declared `.catch`, which runs on a grace budget with the same next and answers instead. a wrong-shaped return is always skipped. |
| recursion | a hook never sees the dispatches it raised (its $ calls, its next, its spawned agent); its sibling hooks and everyone else do. |
| trust | plugins are trusted code with the process's reach. orgs govern by admission: a hook on `plugin.register` sees each plugin's static uses and may refuse it. |
| classic | every settings hook is wrapped 1:1 as `classic.<Event>` with its exact JSON in and out; the configured shell hooks are core for that seam. |
| orgs | managed machine or Team / Enterprise plan: sec-default sits outermost, so a person's plugins cannot touch classic hooks, prompt sections, settings reads or an org-provided tool's description. an org that sets prependPlugins owns that tier: it lists `sec-default@builtin` there, or not. |
| globs | `on("tool.*")`, `on("classic.*")`, `on("*")`: e narrows to the union of the matching events. |
| agents | tool.call inside a subagent carries agentId; `$.agent.list()` maps it to name, parentId, type. Origin (which plugin) and agent (which loop) are separate axes. |
| loading | `plugin.json` + `hooks/hooks.json` `{ "modules": ["./hooks.js"] }`. `claude --plugin-dir ./my-mod` hot-reloads on save, and Claude can write the mod for you. |

## $ · nouns and verbs · each verb is also an event others can hook

| Noun | Verb | What it does |
|---|---|---|
| `$.tool` | `.call` | run a tool through the hooks and permissions |
| | `.list` | tools the model has now |
| | `.register` | give the model a new tool |
| `$.command` | `.run` | run /command as if typed |
| | `.list` | slash commands available |
| | `.register` | add /yourcommand |
| `$.prompt` | `.submit` | queue a prompt as this plugin |
| | `.fill` · `suggest` | write the prompt box · propose dim text into it |
| `$.agent` | `.spawn` | start a subagent, resolves when it settles |
| | `.list` | subagents: id, name, parentId, status |
| `$.turn` | `.abort` | cancel the running turn |
| `$.session` | `.id` · `cwd` · `repo` · `model` | reads: identity, where, which model |
| | `.surfaces` · `turns` | reads: the surfaces attached now, turns so far |
| | `.messages` | the transcript, one entry per message |
| | `.usage` | context window fill, rate limits, cost |
| | `.compact` | compact now; goes through session.compact like /compact |
| | `.authorize` | opaque credential handle, spent by http.fetch |
| `$.model` | `.complete` | one completion on the session's client |
| | `.fork` | tool-less completion over this transcript, cache-shared |
| | `.classify` | pick one of your labels for a text |
| `$.ui` | `.log` · `notice` | a transcript line · a line under a dialog |
| | `.toast` · `status` | the notification bar · your status-line slot |
| | `.ask` | the engine's AskUserQuestion dialog |
| | `.open` · `close` | panes |
| | `.invalidate` | re-run a cached event: ui.render, prompt.section, tool.describe |
| | `.resolve` | the element constructors for e.surface |
| `$.fs` | `.read` · `write` · `list` | the host filesystem, with the process's reach |
| | `.stat` · `exists` | kind/size/mtime · never rejects |
| | `.ancestors` | named instruction files above cwd |
| `$.settings` | `.read` | the resolved settings, or one source's layer: `{ source: "policy" }` |
| `$.config` | `.set` · `list` | change a /config row through the menu's own door · the rows |
| `$.env` | `.get` · `set` | one variable by LITERAL name; validate lists what you read and write |
| `$.store` | `.get` · `set` · `delete` · `keys` | per-plugin persisted JSON |
| `$.http` | `.fetch` | through the host; `{ auth }` spends an authorize handle |
| `$.process` | `.run` | argv on the host, no shell; stdout/stderr/code |
| `$.mcp` | `.call` | a tool on a connected MCP server |
| `$.clock` | `.now` · `sleep` · `after` · `every` | time and timers, cancel-able |
| `$.audio` | `.play` · `speak` | a clip; the platform synthesizer |
| `$.plugin` | `.name` · `root` | who you are, where you live |

## Engine events · on("…")

Side effect column (the sheet's filled and hollow diamonds): **yes** = core has a side effect: no next = it did not happen, next twice = it happened twice. **no** = core has no side effect.

A sub-event row stands for `<parent>.<sub>` (for example `tool.describe`, `session.compact`, `ui.press`).

| Event | Side effect | Shape / meaning |
|---|---|---|
| `tool.call` | yes | `e = { tool, tool_use_id, agentId?, …input } → result \| { deny }` |
| ↳ `describe` | no | what the model is told a tool is · e.provider: who ships it |
| ↳ `check` | no | the permission decision → `{ decision }` |
| `prompt.submit` | yes | the typed prompt; core runs the turn → `{ text, context[] }` |
| ↳ `fill` · `suggest` | yes | text written into the box · the dim proposal after a turn; rewrite or refuse |
| ↳ `context` | no | per-turn injected context |
| ↳ `section` | no | a system-prompt section |
| `turn.start` | no | `{ turnId, text }` · before the turn |
| ↳ `step` | yes | one model request, streamed: `async function*` hook, `yield* next({ ...e, model, effort })` |
| ↳ `complete` | no | `{ text }` · usage · after the turn |
| `session.start` | no | `{ cwd, … }` once per session |
| ↳ `receive` | no | an inbound delivery before it enters context → `{ text } \| { consumed }` |
| ↳ `compact` | yes | `{ trigger, instructions?, messages } → { messages } \| { skip }` |
| ↳ `attach` | no | and detach: a surface (desktop, phone) joined or left, `{ surface, clientId }` |
| `agent.spawn` | yes | `{ prompt, model, provider, parentAgentId?, … } → { text }` |
| ↳ `offer` | no | which agent types the model is offered |
| `command.run` | yes | `/name args → { text }` |
| ↳ `describe` | no | a command's listing · e.provider |
| `config.set` | yes | a /config row changed: `{ key, value, previous, provider } → { value } \| { deny }` |
| ↳ `describe` | no | a row as the menu lists it: relabel or hide |
| `ui.render` | no | `{ surface, component, props } → element tree` |
| ↳ `press` · `input` | yes | a Button / Input you drew was used |
| ↳ `message` | yes | data posted by your Client surface module |
| ↳ `resolve` | no | element table for a surface |
| `skill.prompt` | no | a skill's text as it loads |
| `engine.create` | no | the $ fold itself: add or withhold nouns |
| `plugin.register` | no | admission: `{ name, tier, uses[] } → allow \| refuse` |
| `classic.*` | yes | exact settings-hook JSON in/out; shell hooks are core |
| `*` | yes | every event above and every $ op (fs.read, http.fetch, store.set, …), at your position, with the same powers: rewrite, refuse, next.to |

one fold: e goes down, each link refining the question (innermost last); core answers; the result comes up (outermost last)

## Order is nesting · three views of one fold

`X = A ∘ B ∘ C ∘ core = A(B(C(core(⊥))))`

The sheet draws the same fold three ways:

1. from the front: a sequence diagram. run, call next(e), wait hollow, resume.
2. turned: each bar was a ring. its hollow middle is the call beneath.
3. from above: an onion, core innermost. earlier wraps more: position is authority.

add a noun for everyone:

```ts
on("engine.create", async ($, e, next) => ({ ...await next(e), audit: { record } }))
```

## Drawing · ui.render

```tsx
on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
  const { Box, Text, Button } = await $.ui.resolve(e)
  const drawn = await next(e)   // what beneath drew
  return <Box>
    {drawn}
    <Text dimColor>{e.props.output.length} chars</Text>
    <Button label="copy" onPress={() => $.ui.toast("copied")} />
  </Box>
})
```

| Topic | |
|---|---|
| components | UserMessage · AssistantMessage · ToolUse · ToolResult · ToolGroup · AskUserQuestion · Spinner<br>TurnDuration · InfoNotice · SessionMode · PromptHint · AbovePrompt · Pane |
| elements | Box · Text · Button · Input · Select · Link · Code · Svg · Client<br>terminal draws Ink, desktop draws DOM + Svg, mobile a smaller table; one tree, the surface picks the constructors |
| pane | `$.ui.open({ id })` + `on("ui.render", { component: "Pane", requestId: id }, …)`<br>a render site you open; its body is whatever your hook draws; `$.ui.close({ id })` ends it |
| redraw | `$.ui.invalidate("ui.render")`<br>the engine re-asks every live site of yours; scroll position never moves |
| hover | `Box({ key, hover: { borderColor: "cyan" }, children })`<br>declared on the element, applied by the surface; no event, no round trip |
| client | `Client({ module: "./board.js", key, props })`<br>surface-side JS with no $ (state, pointer, keys); replies only via Buttons and surface.post → ui.message |
