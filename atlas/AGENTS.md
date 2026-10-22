# Atlas

An interactive architecture map on two levels, served by Bun to the browser: an overview of
every zone with its bricks, and a detail of every brick and arrow, one zone at a time. ELK lays
out the boxes in the page, libavoid routes the overview's arrows from WebAssembly, and nothing in
the data has a position or a size. Open points carry threads between the human and the agent.
A mod (`hooks/`) serves a map folder's page on `/atlas:board`, hands the human's selection in
the page to the agent, and gives the agent its tools on the map.

## Files

Content lives only in a map folder; the engine's modules change only for behaviour. A map folder
holds `map.ts` (its AtlasMap, the default export), `atlas.config.ts` (its Config, the default
export), `threads.json` (the thread of each open point, by open id), a `.gitignore` that lists
`drafts/`, and the two files `sync` writes and `check` compares byte for byte: `atlas.d.ts`, a
copy of `atlas.ts` its data imports its types from, and `tsconfig.json`, a copy of the
template's. It needs no `package.json`: its data imports types only. Its data files are its `.ts`
files but `atlas.d.ts`. Its drafts sit in `drafts/<name>/`, which its check leaves out; each
holds a copy of the map's own files, a map folder of its own.

```
cli.ts               the one command line of agents and skills: new, sync, check, fmt, reply, draft
                     (cli.spec.ts, on copies in temporary folders)
drafts.ts            a map folder's data files, and its drafts: made, adopted, dropped
atlas.ts             the format of a map, types only: Node (a tree, `children`), Link, AtlasMap
                     (the root and every link), Config (title, language, palette, pins, overview
                     packing, tags, legend labels, step words); the source of a map's atlas.d.ts
template/            the map folder `new` copies; its tsconfig.json is the one `sync` writes
lint/                the oxlint and oxfmt configs `check` and `fmt` run on a map's data files
fixtures/sample/     the sample map folder
folder.ts            the map folder's files (loadFolder), the plan its data makes (planOf), and its
                     labels by id, the ids a selection may name (labelsOf, folder.spec.ts)
aliases.d.ts         the types of atlas:map and atlas:config, the page's imports of a map folder
settings.ts          the Config with its defaults filled in, refusing what the engine cannot use,
                     and the palette as the page's CSS custom properties (settings.spec.ts)
words.ts             the page's own words in each language a Config picks: the dictionary
model.ts             the plan the engine draws on two levels (Zone, Brick, Edge, Info)
adapter.ts           the tree as that plan, refusing a tree the engine cannot draw, a colour
                     outside the palette among them (adapter.spec.ts)
graph.ts             graphOf: the plan with the lookups both drawings and the panel share
threads.ts           open points and threads, pure: who a point waits for (threads.spec.ts)
check.ts             validates a map folder's ids, couplings, nesting, labels, tags against the
                     Config's, open points against its step words, and threads, and reports the
                     open points (check.spec.ts)
legend.ts            the legend's lines, one per arrow kind or node mark the map uses
                     (legend.spec.ts)
reply.ts             adds an entry to a thread of a map folder (reply.spec.ts)
query.ts             one node of a map folder as JSON: path, children, links, fields, sources
                     (query.spec.ts)
machine.ts           the two state machines, navigation and camera, pure (machine.spec.ts)
engine.ts            the page's entry: draws the map it imports, paints the camera, takes input,
                     posts the reader's selection to serve.ts
overview.ts          the overview drawing
flows.ts             the overview's arrows: the leaves' arrows grouped by the boxes they join
detail.ts            the detail drawing
layout.ts            runs ELK
avoid.ts             runs libavoid
measure.ts           sizes text
frame.ts             draws a zone
panel.ts             the panel, the breadcrumb and the open points' list
svg.ts               SVG building blocks shared by both drawings
atlas.html           the page: its styles and its markup, which hold no word and no colour of a map
serve.ts             serves one map folder's page, rebuilt and reloaded on save, answers
                     libavoid.wasm and threads.json, takes the panel's replies, prints the page's
                     selections, and with --heartbeat leaves with its parent process or a minute
                     after the last beat carrying its secret (serve.spec.ts)
coalesce.ts          one run at a time, with at most one waiting: serve.ts's rebuilds
                     (coalesce.spec.ts)
wire.ts              what crosses between the page, serve.ts and the mod: routes, a selection,
                     the server's JSON line; bunFlags, which every bun atlas starts takes
child.bunfig.toml    the empty Bun configuration bunFlags names
open.ts              hands an address to the desktop's browser, detached, for the mod (open.spec.ts)
hooks/               the mod: register.ts spells `$`, server.ts the server's start, beat and the
                     command lines the tools run, parse.ts the boundary, register.test.ts the kit's
                     tests over fixtures.ts
skills/board, stop   /atlas:board [map folder] [draft name] and /atlas:stop, the person's alone
```

The mod keeps one server per map folder, whichever session asks. Its store keeps, under
`map:<folder>`, that folder's live server, its port and the session that started it, or the claim
of a session starting one, under `session:<id>` the folders a session shows (a reload attaches
them again), and under `selection:<folder>` the page's last selection, which every session showing
that map adds to its next prompt's context once. A session claims the folder before it starts a
server and starts it only if its claim still stands `CLAIM_SETTLE_MS` later; another session's
fresh claim is waited out, and a server is forgotten only while the store still names it. That
`$.store` holds against two sessions writing at once is not measured: one probe saw another
process's write within a second (`docs/plugin-testing/hook-runtime.md`). The first session to
ask spawns `serve.ts --heartbeat` with a secret of its own in `$ATLAS_HEARTBEAT`, reads its
stdout, and beats it with that secret; another session joins it and only probes it, so the server
never outlives the session that reads it: it leaves once its parent process changes (a `claude`
killed hard) or a minute after the last beat, and a joined session then starts its own on the
same port. A server that crashes comes back on its port, three ends within a minute leave the
board lost; a SIGTERM from outside, as Claude Code ends its children on exit, revives nothing.

`package.json` pins the libraries, elkjs (EPL-2.0) and libavoid-js (LGPL-2.1-or-later,
github.com/Aksem/libavoid-js), and the checkers tsgo, oxlint and oxfmt, as runtime dependencies.

## Commands

Every command runs from the repository root.

```bash
bun install --cwd atlas --frozen-lockfile   # once; Claude Code does it at the plugin's cache
bun atlas/cli.ts new <dir>                  # scaffold a map folder in an empty or new folder
bun atlas/cli.ts sync <map folder>          # write atlas.d.ts and tsconfig.json from the plugin, and drafts/ into .gitignore
bun atlas/cli.ts check <map folder>         # the plan, tsgo, oxlint, oxfmt, the two copies; exit 1 on any failure
bun atlas/cli.ts check <map folder> --open  # list the open points and whom each waits for
bun atlas/cli.ts fmt <map folder>           # format in place the files check format-checks
bun atlas/cli.ts reply <map folder> <open id> --as agent "<text>"   # answer an open point; an agent always writes as agent
bun atlas/cli.ts draft <map folder> <name>  # copy the map's own files into drafts/<name> and print its path
bun atlas/cli.ts draft <map folder> <name> --adopt   # its data files and threads.json replace the map's, then it is deleted; --drop deletes it
bun test atlas                              # the engine's suites, *.spec.ts
bun atlas/query.ts <map folder> <node id>   # one node as JSON
bun atlas/serve.ts <map folder> [port]      # serve the page; it prints its address and reloads on save
claude plugin validate atlas                # what the mod hooks and calls
claude plugin test atlas                    # the mod's kit tests, hooks/*.test.ts
claude --plugin-dir atlas                   # a live session with the mod from source
```

The sample map folder is `atlas/fixtures/sample`.

## Traps

Each module explains its own where it bites.

- The text classes `measure.ts` measures (`TEXT` and `TITLE` there) keep the font sizes
  `atlas.html` gives them, or text overflows its box.
- `svg text { text-rendering: geometricPrecision }` stays in `atlas.html`: without it, Chrome
  rounds font sizes per zoom and drawn text drifts from the width `measure.ts` measured.
- The order of a node's `children` is the order in which the overview packs them, and the
  order of the plan's zones and bricks: reordering them moves boxes.
- Every child of the root that is not `outside` and has children holds a node with children:
  `pack` in `overview.ts` asks for a `<zone>~own` block that `blocksOf` makes only for a zone
  that nests others. `toPlan` refuses such a tree, naming the node, and so do
  `bun atlas/cli.ts check <map folder>`, which builds the plan, and `serve.ts`, which answers an
  error page instead of the map. The template's map nests a node for this reason.
- `atlas/fixtures/sample` and `atlas/template` each commit an `atlas.d.ts`, a copy of `atlas.ts`:
  after a change to `atlas.ts`, `bun atlas/cli.ts sync` both, or `cli.spec.ts` fails on them.
- A process that imported a map folder keeps that first evaluation: importing it again answers
  the old data, and a `?query` on the specifier refreshes the file named but not what it imports.
  `serve.ts` therefore loads the folder in a fresh process (`bun atlas/folder.ts <map folder>`) on
  every build.
- `libavoid.wasm` is the installed libavoid-js package's own: its exports list only the entry
  point, so `serve.ts` resolves the file beside that entry and answers it beside the page. No
  copy is committed. A page that cannot load it draws the overview without arrows and says so in
  the panel (`arrowsMissing` in `words.ts`).
- `dressPage` (engine.ts) writes the Config's title, subtitle and words into the page before the
  first layout: the header's height sets the drawing area's aspect, which a "screen" overview
  packs for. Written later, the overview packs for another aspect.
- The legend shows a line only for the arrow kinds and node marks the map draws (`legendKeys` in
  `legend.ts`): a kind the map never uses has no line.
- Layout runs in the browser only. To script it (a check, a benchmark), run elkjs under Node:
  under Bun its constructor fails.
- A map folder's files are code: its `map.ts` and `atlas.config.ts` run in every command on it,
  and a `bunfig.toml` or a `.env` in the folder a bun starts in preloads more. Every bun atlas
  starts, from the mod, `serve.ts` or `cli.ts`, takes `bunFlags` (`wire.ts`) before its script,
  and the mod's tools run a map outside the session's folder, that no board of the session shows,
  only once the person allows it.
- `claude plugin test atlas` runs every `*.test.ts` under `atlas/` in the engine's environment,
  where a `bun:test` suite fails: the engine's suites are `*.spec.ts`, and the root `bunfig.toml`
  keeps `bun test` off `atlas/**/*.test.ts`.
