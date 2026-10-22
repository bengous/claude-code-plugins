# Atlas

An interactive architecture map on two levels, served by Bun to the browser: an overview of
every zone with its bricks, and a detail of every brick and arrow, one zone at a time. ELK lays
out the boxes in the page, libavoid routes the overview's arrows from WebAssembly, and nothing in
the data has a position or a size. Open points carry threads between the human and the agent.

## Files

Content lives only in a map folder; the engine's modules change only for behaviour. A map folder
holds `map.ts` (its AtlasMap, the default export), `atlas.config.ts` (its Config, the default
export) and `threads.json` (the thread of each open point, by open id), and needs no
`package.json`: its data imports types only.

```
atlas.ts             the format of a map, types only: Node (a tree, `children`), Link, AtlasMap
                     (the root and every link), Config; the source of a map's atlas.d.ts
fixtures/sample/     the sample map folder; its data imports its types from ../../atlas.ts
folder.ts            the map folder's files, and the plan its data makes (planOf, a dynamic import)
aliases.d.ts         the types of atlas:map and atlas:config, the page's imports of a map folder
model.ts             the plan the engine draws on two levels (Zone, Brick, Edge, Info)
adapter.ts           the tree as that plan, refusing a tree the engine cannot draw (adapter.test.ts)
graph.ts             graphOf: the plan with the lookups both drawings and the panel share
threads.ts           open points and threads, pure: who a point waits for (threads.test.ts)
check.ts             validates a map folder's ids, couplings, nesting, labels, tags, open points
                     and threads (check.test.ts); --open lists the open points
reply.ts             adds an entry to a thread of a map folder (reply.test.ts)
machine.ts           the two state machines, navigation and camera, pure (machine.test.ts)
engine.ts            the page's entry: draws the map it imports, paints the camera, takes input
overview.ts          the overview drawing
detail.ts            the detail drawing
layout.ts            runs ELK
avoid.ts             runs libavoid
measure.ts           sizes text
frame.ts             draws a zone
panel.ts             the panel, the breadcrumb and the open points' list
svg.ts               SVG building blocks shared by both drawings
plan.fr.html         the page: its styles, its header and its legend
serve.ts             serves one map folder's page, rebuilt and reloaded on save, answers
                     libavoid.wasm and threads.json, and takes the panel's replies (serve.test.ts)
coalesce.ts          one run at a time, with at most one waiting: serve.ts's rebuilds
                     (coalesce.test.ts)
```

`package.json` pins the libraries, elkjs (EPL-2.0) and libavoid-js (LGPL-2.1-or-later,
github.com/Aksem/libavoid-js), and the checkers tsgo, oxlint and oxfmt, as runtime dependencies.

## Commands

Every command runs from the repository root.

```bash
bun install --cwd atlas --frozen-lockfile   # once; Claude Code does it at the plugin's cache
bun atlas/check.ts <map folder>             # validate the data and threads.json; --open lists the open points
bun atlas/reply.ts <map folder> <open id> --as agent "<text>"   # answer an open point; an agent always writes as agent
bun test atlas                              # the engine's suites
bun atlas/serve.ts <map folder> [port]      # serve the page; it prints its address and reloads on save
```

The sample map folder is `atlas/fixtures/sample`.

## Traps

Each module explains its own where it bites.

- The text classes `measure.ts` measures (`TEXT` and `TITLE` there) keep the font sizes
  `plan.fr.html` gives them, or text overflows its box.
- `svg text { text-rendering: geometricPrecision }` stays in `plan.fr.html`: without it, Chrome
  rounds font sizes per zoom and drawn text drifts from the width `measure.ts` measured.
- The order of a node's `children` is the order in which the overview packs them, and the
  order of the plan's zones and bricks: reordering them moves boxes.
- Every child of the root that is not `outside` and has children holds a node with children:
  `pack` in `overview.ts` asks for a `<zone>~own` block that `blocksOf` makes only for a zone
  that nests others. `toPlan` refuses such a tree, naming the node, and so do
  `bun atlas/check.ts <map folder>`, which builds the plan, and `serve.ts`, which answers an error
  page instead of the map.
- A process that imported a map folder keeps that first evaluation: importing it again answers
  the old data, and a `?query` on the specifier refreshes the file named but not what it imports.
  `serve.ts` therefore loads the folder in a fresh process (`bun atlas/folder.ts <map folder>`) on
  every build.
- `libavoid.wasm` is the installed libavoid-js package's own: its exports list only the entry
  point, so `serve.ts` resolves the file beside that entry and answers it beside the page. No
  copy is committed. A page that cannot load it draws the overview without arrows and says so in
  the panel ("Flèches absentes").
- Layout runs in the browser only. To script it (a check, a benchmark), run elkjs under Node:
  under Bun its constructor fails.
