# Atlas

An interactive architecture map, served by Bun to the browser: a tree of nodes, drawn one
container's view at a time, at any depth. A view shows the children of the open container, a
container child as a box naming its own children, a leaf child as a card, the neighbours outside
the container as ghosts at the edge, and one arrow per pair lifted to what it shows. ELK lays each
view out in the page, libavoid routes the arrows of a view with a container child from
WebAssembly, and nothing in the data has a position or a size. Open points carry threads between
the human and the agent. A mod (`hooks/`) serves a map folder's page on `/atlas:board`, hands the
human's selection in the page to the agent, and gives the agent its tools on the map.

## Files

Content lives only in a map folder; the engine's modules change only for behaviour. A map folder
holds `map.ts` (its AtlasMap, the default export), `atlas.config.ts` (its Config, the default
export), `threads.json` (the thread of each open point, by open id), a `.gitignore` that lists
`drafts/`, and the two files `sync` writes and `check` compares byte for byte: `atlas.d.ts`, a
copy of `atlas.ts` its data imports its types from, and `tsconfig.json`, a copy of the
template's. It needs no `package.json`: its data imports types only. Its data files are its `.ts`
files but `atlas.d.ts`, in sub-folders too: a large map keeps each branch in `parts/<branch>.ts`,
which exports its `node` and its `links` with types from `../atlas.d.ts`, and `map.ts` assembles
them (parts.spec.ts holds check, fmt and the page's bundle to it). Its drafts sit in
`drafts/<name>/`, which its check leaves out; each holds a copy of the map's own files, a map folder
of its own.

The plugin's root holds what Claude Code loads (`.claude-plugin/`, `hooks/`, `skills/`), what
`cli.ts` copies or runs on a map folder (`template/`, `lint/`, `child.bunfig.toml`), the specs'
`fixtures/`, and `src/`, where every module of the engine lives. A new module goes in the folder
of its layer, never at a root, its spec beside it. `model/` imports nothing outside itself;
`inventory/` imports nothing outside itself; `page/` and `commands/` import `model/`;
`server/wire.ts` is the one module the page, `serve.ts`, `cli.ts` and the mod all import.

```
src/cli.ts           the one command line of agents and skills, and of the mod's tools: new, sync,
                     check, fmt, reply, draft, query (one node as JSON, read from tree.ts),
                     inventory (cli.spec.ts, on copies in temporary folders)
src/serve.ts         serves one map folder's page, rebuilt and reloaded on save, answers
                     libavoid.wasm, threads.json and the lines a citation names
                     (server/source.ts), takes the panel's replies, prints the page's
                     selections, and with --heartbeat leaves with its parent process or a minute
                     after the last beat carrying its secret (serve.spec.ts)
src/standalone.spec.ts  serves the sample from a copy of the plugin outside any repository, as an
                     install does
src/parts.spec.ts    a map assembled from parts/*.ts through check, fmt and the page's bundle

src/model/           the map and what is read from it, pure or Node-only, no browser
  atlas.ts           the format of a map, types only: Node (a tree, `children`), Link, AtlasMap
                     (the root and every link), Config (title, language, palette, pins, packing
                     ratio, reading direction, tags, legend labels, panel headings, step words,
                     sources root); the source of a map's atlas.d.ts
  folder.ts          the map folder's files (loadFolder), and its labels by id, the ids a selection
                     may name (labelsOf, folder.spec.ts); its sources root, a draft's from the
                     map it drafts (sourcesRootOf); run, it prints them with the paths the map
                     cites (FolderLine), or refuses a folder the engine cannot draw, which
                     serve.ts asks before each build
  settings.ts        the Config with its defaults filled in, refusing what the engine cannot use,
                     and the palette as the page's CSS custom properties (settings.spec.ts)
  drawable.ts        the tree and the settings a map folder makes, or why no view can show it:
                     treeOf's and settingsOf's refusals, a colour outside the palette, markup a
                     panel would not keep
  markup.ts          the markup a panel keeps from a map's text (code, cite, b, i, em, strong, br,
                     no attribute), the rest shown as text, and the faults check and the server
                     refuse, by node and field (markup.spec.ts)
  citations.ts       a <cite>path:lines</cite> read as a citation, pure, and every citation of a
                     map by node and field, and every <cite> that looks like one but reads as
                     none (citations.spec.ts)
  sources.ts         the file a citation's path names under the Config's sources root, Node-only:
                     no absolute path, no `..`, no link out of the root; and its lines, for a
                     file with no NUL byte under a cap (SOURCE_CAP_BYTES for the page), bytes not
                     UTF-8 read as U+FFFD, read through one descriptor opened without following a
                     link or waiting on a FIFO, every filesystem error a refusal (sources.spec.ts)
  words.ts           the page's own words in each language a Config picks: the dictionary
  tree.ts            the tree indexed for views at any depth: each node's chain from the root,
                     open points counted down each subtree, couplings both ways, and what stands
                     for a node in a container's view (a child, or a ghost); refuses what no view
                     can show (tree.spec.ts)
  view.ts            the view of any container: its children as boxes, a container child's
                     children as its chips; its links lifted to one arrow per pair; its outer
                     neighbours as ghosts in side columns; the couplings a selection outlines and
                     the arrows it lights; the legend lines it uses (view.spec.ts; scale.spec.ts
                     bounds the time of the index and a view on a map of 5,000 nodes)
  cards.ts           a container's leaf children side by side: a column per leaf, a row for the
                     leads unless none has one, then one per first element of their `io` pairs;
                     none for fewer than two leaves, or when no leaf has `io` (cards.spec.ts)
  navigation.ts      where the reader stands at any depth: the path to the open container and the
                     selection, their events, the breadcrumb and its fold to one line, the URL
                     fragment that carries both and the parameters of the reading state (its
                     grammar on `Params`), and the page's state window.atlas shows agents
                     (navigation.spec.ts)
  threads.ts         open points and threads: who a point waits for (threads.spec.ts)

src/commands/        what cli.ts does to a map folder
  check.ts           validates a map folder: what drawable.ts refuses, then a brief on a leaf, a
                     rank on an outside node, the root's tour, see/seams/traps ids on every panel,
                     a <cite> that reads as no citation, tags against the Config's, open points against its step words, and threads,
                     and reports the open points; with the Config's sources, each cited file,
                     read once as serve.ts reads it but for the size cap, and its lines, or the
                     missing root in one line (check.spec.ts)
  reply.ts           adds an entry to a thread of a map folder (reply.spec.ts)
  drafts.ts          a map folder's data files, and its drafts: made, adopted, dropped

src/inventory/       what a repository holds, as JSON, model-free, for /atlas:init
  inventory.ts       the summary and the one pass that keeps no text: the files listing.ts lists
                     (git, or a walk honouring the root's .gitignore, every path it cannot read
                     set aside with its code); directories of the top two levels; the manifests
                     (manifests.ts, their boundary parsers); the imports between those
                     directories and the environment variables read, by pattern (scan.ts)
                     (inventory.spec.ts, on repositories it writes in temporary folders;
                     scan.spec.ts bounds every pattern on crafted files)

src/page/            what runs in the browser
  atlas.html         the page: its styles and its markup, which hold no word and no colour of a map
  aliases.d.ts       the types of atlas:map and atlas:config, the page's imports of a map folder
  engine.ts          the page's entry: draws the view of the open container the first time the
                     reader reaches it and keeps it, paints the camera, takes input, posts the
                     reader's selection to serve.ts
  stage.ts           the stage, pure: the views held, the one being laid out, those wanted now or
                     later, and what a relayout keeps or lays out again (stage.spec.ts)
  draw.ts            the renderer of one view: packed (ELK rectpacking or bands by rank, the sides,
                     libavoid) when the view has a container child, layered (ELK layered, labels
                     and tags) when it has leaves alone
  placement.ts       the pure parts of placing a view: the middle items in bands by rank, the side
                     columns, or bands under DOWN, the chips wrapped in a box, the spot of each
                     arrow's label, the copies of an item drawn twice (placement.spec.ts)
  camera.ts          the camera, pure: the view shown and the one it cross-fades with, aligned
                     through the boxes along their path, any number of levels at once
                     (camera.spec.ts)
  zoom.ts            the free look inside a view, pure: the camera's rect zoomed around a point
                     or panned, kept within the rect that fits the view, and the captions a scale
                     leaves readable (zoom.spec.ts)
  layout.ts          runs ELK's layered layout, flat, in the map's direction, its rows wrapped to an
                     aspect or its layers partitioned by rank, a ghost held to the first or the last
                     layer (layout.spec.ts, which runs ELK under Bun)
  avoid.ts           runs libavoid (avoid.spec.ts)
  legend.ts          the legend's lines, one per arrow kind or node mark a view uses
                     (legend.spec.ts)
  panel.ts           the panel, the breadcrumb and the open points' list; fieldHtml, the one way
                     an HTML field reaches the page, its citations as markers; the viewer of a
                     citation's lines; the cards' table (panel.spec.ts)
  measure.ts         sizes text: one scale for every view
  geometry.ts        rects, points and similarities
  svg.ts             SVG building blocks

src/server/          what crosses processes
  wire.ts            what crosses between the page, serve.ts and the mod: routes, a selection,
                     the lines a citation names, the server's JSON line; bunFlags, which every
                     bun atlas starts takes
  source.ts          the route of a citation's lines and its refusals, the plugin's one route
                     that reads a file of the user's (source.spec.ts)
  coalesce.ts        one run at a time, with at most one waiting: serve.ts's rebuilds
                     (coalesce.spec.ts)
  open.ts            hands an address to the desktop's browser, detached, for the mod (open.spec.ts)

child.bunfig.toml    the empty Bun configuration bunFlags names
template/            the map folder `new` copies; its tsconfig.json is the one `sync` writes
lint/                the oxlint and oxfmt configs `check` and `fmt` run on a map's data files
fixtures/sample/     the sample map folder
fixtures/deep/       a map folder five levels deep, the specs' DEEP, to look at in the browser;
                     fixtures/large/ a seeded random map, wide and deep, to time a view on;
                     fixtures/bands/ a map read DOWN, its views in bands by rank, to look at;
                     fixtures/citations/ a map whose panels end each claim with a citation of
                     its repo/, its sources root;
                     the four import the plugin's own types and carry no generated files
fixtures/trees.ts    a map five levels deep, and seeded random maps, for the specs
hooks/               the mod: register.ts spells `$`, server.ts the server's start, beat and the
                     command lines the tools run, parse.ts the boundary, register.test.ts the kit's
                     tests over fixtures.ts
skills/board, stop   /atlas:board [map folder] [draft name] and /atlas:stop, the person's alone
skills/init          /atlas:init [map folder], the person's alone: a first map, inventory to verified
                     parts; branch-brief.md and verify-brief.md are its subagents' prompts
```

The mod keeps one server per map folder, whichever session asks. Its store keeps, under
`map:<folder>`, that folder's live server, its port and the session that started it, or the claim
of a session starting one, under `session:<id>` the folders a session shows (a reload attaches
them again), and under `selection:<folder>` the page's last selection, which every session showing
that map adds to its next prompt's context once. A session claims the folder before it starts a
server and starts it only if its claim still stands `CLAIM_SETTLE_MS` later. Before it claims, it
probes both its own last port and the one the store names, and reads the record again, as a probe
may wait long on a port: what another session wrote meanwhile is looked at anew. Another session's
claim younger than `CLAIM_MS`, and not dated ahead of the clock, is waited out, and a server is
forgotten only while the store still names it. `$.store.set` and `$.store.delete` take a lock and
rewrite the store's file, and `get` reads it afresh, so each write lands whole and the next read
sees it (`docs/plugin-testing/hook-runtime.md`); a read and the write after it are not one step,
which the settle covers. A start that a failing store or clock breaks drops the board and its
claim, and says why. The first session to
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
bun install --cwd atlas --frozen-lockfile       # once; Claude Code does it at the plugin's cache
bun atlas/src/cli.ts new <dir>                  # scaffold a map folder in an empty or new folder
bun atlas/src/cli.ts sync <map folder>          # write atlas.d.ts and tsconfig.json from the plugin, and drafts/ into .gitignore
bun atlas/src/cli.ts check <map folder>         # the map and its citations, tsgo, oxlint, oxfmt, the two copies; exit 1 on any failure
bun atlas/src/cli.ts check <map folder> --open  # list the open points and whom each waits for
bun atlas/src/cli.ts fmt <map folder>           # format in place the files check format-checks
bun atlas/src/cli.ts reply <map folder> <open id> --as agent "<text>"   # answer an open point; an agent always writes as agent
bun atlas/src/cli.ts draft <map folder> <name>  # copy the map's own files into drafts/<name> and print its path
bun atlas/src/cli.ts draft <map folder> <name> --adopt   # its data files and threads.json replace the map's, then it is deleted; --drop deletes it
bun atlas/src/cli.ts query <map folder> <node id>   # one node as JSON: path, children, links, couplings, fields, sources
bun atlas/src/cli.ts inventory <repo> [--summary]   # what a repository holds, as JSON; --summary for a first read
bun test atlas                                  # the engine's suites, *.spec.ts
bun atlas/src/serve.ts <map folder> [port]      # serve the page; it prints its address and reloads on save
claude plugin validate atlas                    # what the mod hooks and calls
claude plugin test atlas                    # the mod's kit tests, hooks/*.test.ts
claude --plugin-dir atlas                   # a live session with the mod from source
```

The sample map folder is `atlas/fixtures/sample`; `atlas/fixtures/deep` goes five levels down.

## The page

- The URL's fragment is the place (`hashOf` in `navigation.ts`): a bare `#id` opens a container's
  view, or a leaf's parent's view with the leaf selected; `#<open>/<selected>` carries a selection
  no bare id lands on, a ghost or a container among them. After a `?` come the parameters of the
  reading state, `key=value` joined by `&`, each written only away from its default, such as
  `#app?mode=cards`; their grammar, the rules every new one follows and what survives a move are
  on `Params`. A fragment typed into the address bar is followed.
- `window.atlas` is what an agent reads of the page without a screenshot (`pageStateOf` in
  `navigation.ts`): the open path, the selected id, the ids the open view draws (boxes, chips,
  ghosts), each parameter of the fragment (`mode`) and the fragment, frozen and replaced at each
  move, with the view's `zoom`, 1 at its fit (`zoomOf` in `engine.ts`), `sourcesInFull`, and the
  `citation` whose lines the panel shows, or null; a getter, so a page script cannot assign it.
- A `<cite>` whose text is a citation (`citationOf` in `citations.ts`) shows as a small mono
  marker of its lines, the whole citation as its tooltip; a `<cite>` of other text, a `kicker`,
  and a `label`, plain text even as the heading of a node without `title`, show as written. The header's Sources toggle, shown when the map has a citation, shows every
  citation in full, remembered per browser under `atlas.sources` (`sourcesInFull`).
- With the Config's `sources`, a marker is a button: a click shows each cited stretch and eight
  lines around it in the panel, a `…` row between stretches apart, long lines wrapped, read from
  serve.ts, under the path and a close button, until the close button, Escape or a move; a file
  over the route's cap shows as too large to show. serve.ts knows the paths the map cites only
  from folder.ts's line.
- A view whose container has two leaf children or more, one of them with `io` (`cardsOf` in
  `cards.ts`), the root's included, gets a Map | Cards switch in the stage's controls. Cards
  (`mode=cards`) lays the container's leaves over the drawing as a table (`cardsHtml` in
  `panel.ts`): a column per leaf, in data order, its header in its colour selecting it; a row of
  leads, unless no leaf has one, then one per `io` key, each cell through `fieldHtml`, a marker
  opening its lines in the panel, shown if it was hidden; a click elsewhere on the cards does
  nothing. The header row and the keys' column stay in sight as it scrolls, below the controls,
  which wrap within the stage. The drawing stays laid out beneath, inert, keeping its zoom, which
  Escape leaves alone, the fit button disabled; the legend and the hint hide. Another container
  opens on its drawing.
- Escape closes the lines viewer, then deselects, then goes up one level; so does a click on the
  empty sheet. A box enters its
  container, a card or a ghost is selected where it stands, a chip jumps to its node.
- Inside a view, the wheel zooms around the pointer, a drag pans and two fingers pinch, within
  the rect that fits the view (`zoom.ts`); the fit button, Escape and a click on the empty sheet
  bring the fit back before they do anything else, but over the cards, and a move to another
  view starts at its fit.
- A caption (an arrow's label, a box's tag, a line of a card's sub-title) under 10 px on screen
  hides, keeping its spot, unless its arrow is lit by a hover or a keyboard focus or hot from the
  selection, or its own box or card is hovered, focused or selected (`captionShown` in
  `zoom.ts`). An invisible band 8 px wide on screen along each arrow carries its whole label as a
  tooltip; the bands lie under the boxes, so a click on a box's edge where an arrow lands enters
  the box.
- The breadcrumb stays on one line: from five crumbs on, the levels between the root and the
  last two fold into `…`, their names in its tooltip (`foldedCrumbs` in `navigation.ts`).
- A ghost drawn on both sides carries a `›` mark at the edge its arrows cross and a tooltip
  naming the copy; hovering one copy lights both.
- A move between a view and one of its ancestors cross-fades the two, the deeper one aligned on
  its box; a move between two views neither of which holds the other lands at once.
- A view is laid out the first time the reader reaches it, then kept; its parent and its
  container children are laid out while the reader looks, a navigated view before any of them.
  Every view is laid out again when the drawing area's aspect moves, with the Config's ratio
  "screen" (a packed view aims at it and a layered view wraps its rows to it, but for a view in
  bands by rank), and when the fonts settle late. `performance.measure("atlas:draw <view>")` times each layout.

## Traps

Each module explains its own where it bites.

- The text classes `measure.ts` measures (`CARD`, `CHIP`, `BOX`, `GHOST` and `LABEL` there) keep
  the font sizes `atlas.html` gives them, or text overflows its box.
- `svg text { text-rendering: geometricPrecision }` stays in `atlas.html`: without it, Chrome
  rounds font sizes per zoom and drawn text drifts from the width `measure.ts` measured.
- The order of a node's `children` is the order in which its view packs them: reordering them
  moves boxes.
- `atlas/fixtures/sample` and `atlas/template` each commit an `atlas.d.ts`, a copy of `atlas.ts`:
  after a change to `atlas.ts`, `bun atlas/src/cli.ts sync` both, or `cli.spec.ts` fails on them.
- A process that imported a map folder keeps that first evaluation: importing it again answers
  the old data, and a `?query` on the specifier refreshes the file named but not what it imports.
  `serve.ts` therefore loads the folder in a fresh process
  (`bun atlas/src/model/folder.ts <map folder>`) on every build.
- `libavoid.wasm` is the installed libavoid-js package's own: its exports list only the entry
  point, so `serve.ts` resolves the file beside that entry and answers it beside the page. No
  copy is committed. A page that cannot load it draws a packed view without arrows and says so in
  the panel (`arrowsMissing` in `words.ts`).
- `dressPage` (engine.ts) writes the Config's title, subtitle and words into the page before the
  first layout: the header's height sets the drawing area's aspect, which a "screen" packing aims
  at. Written later, the views pack for another aspect.
- The legend shows a line only for the arrow kinds and node marks the open view draws
  (`legendKeys` in `legend.ts`): a kind the view never uses has no line.
- ELK's bundle does not start under Bun, where `self` exists: its worker module takes the web
  worker's branch and exports nothing. `layout.spec.ts` builds the layouter it hands `elkLayered`
  from `elk-api.js` and that branch; a script that lays a view out outside a browser (a check, a
  benchmark) does the same, or runs under Node.
- A map folder's files are code: its `map.ts` and `atlas.config.ts` run in every command on it,
  and a `bunfig.toml` or a `.env` in the folder a bun starts in preloads more. Every bun atlas
  starts, from the mod, `serve.ts` or `cli.ts`, takes `bunFlags` (`wire.ts`) before its script,
  and the mod's tools run a map outside the session's folder, that no board of the session shows,
  only once the person allows it.
- `claude plugin test atlas` runs every `*.test.ts` under `atlas/` in the engine's environment,
  where a `bun:test` suite fails: the engine's suites are `*.spec.ts`, and the root `bunfig.toml`
  keeps `bun test` off `atlas/**/*.test.ts`.
