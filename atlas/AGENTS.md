# Atlas

An interactive architecture map on two levels, served by Bun to the browser: an overview of
every zone with its bricks, and a detail of every brick and arrow, one zone at a time. ELK lays
out the boxes in the page, libavoid routes the overview's arrows from WebAssembly, and nothing in
the data has a position or a size. Open points carry threads between the human and the agent.

## Files

Content lives only in the map's data; the other modules change only for behaviour.

```
atlas.ts             the format of a map, types only: Node (a tree, `children`), Link, AtlasMap
                     (the root and every link), Config; the source of a map's atlas.d.ts
map.ts               the sample map: its tree, with the overview panel on the root, and its links
atlas.config.ts      the sample map's Config: the palette its `color` keys name
threads.json         the thread of each open point, by open id
model.ts             the plan the engine draws on two levels (Zone, Brick, Edge, Info)
adapter.ts           the tree as that plan, refusing a tree the engine cannot draw (adapter.test.ts)
plan.ts              the plan built from map.ts, and the reading of its nesting
threads.ts           open points and threads, pure: who a point waits for (threads.test.ts)
check.ts             validates ids, couplings, nesting, labels, tags, open points and
                     threads (check.test.ts); --open lists the open points
reply.ts             adds an entry to a thread (reply.test.ts)
machine.ts           the two state machines, navigation and camera, pure (machine.test.ts)
engine.ts            the page's entry: builds both levels, paints the camera, takes input
overview.ts          the overview drawing
detail.ts            the detail drawing
layout.ts            runs ELK
avoid.ts             runs libavoid
measure.ts           sizes text
frame.ts             draws a zone
panel.ts             the panel, the breadcrumb and the open points' list
svg.ts               SVG building blocks shared by both drawings
plan.fr.html         the page: its styles, its header and its legend
serve.ts             serves the page and drafts/<name>/ over HTTP, answers libavoid.wasm, and
                     takes the panel's replies
```

`package.json` pins the libraries, elkjs (EPL-2.0) and libavoid-js (LGPL-2.1-or-later,
github.com/Aksem/libavoid-js), and the checkers tsgo, oxlint and oxfmt, as runtime dependencies.

## Commands

Every command runs from the repository root.

```bash
bun install --cwd atlas --frozen-lockfile   # once; Claude Code does it at the plugin's cache
bun atlas/check.ts                          # validate the data and threads.json; --open lists the open points
bun atlas/reply.ts <open id> --as agent "<text>"   # answer an open point; an agent always writes as agent
bun test atlas                              # the engine's suites
bun atlas/serve.ts [port]                   # serve the page; it prints its address and reloads on save
```

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
  that nests others. `toPlan` refuses such a tree, naming the node, and so does
  `bun atlas/check.ts`, which builds the plan.
- `libavoid.wasm` is the installed libavoid-js package's own: its exports list only the entry
  point, so `serve.ts` resolves the file beside that entry and answers it next to each page. No
  copy is committed. A page that cannot load it draws the overview without arrows and says so in
  the panel ("Flèches absentes").
- Layout runs in the browser only. To script it (a check, a benchmark), run elkjs under Node:
  under Bun its constructor fails.
