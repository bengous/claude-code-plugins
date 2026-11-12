# architecture-map

Draws a codebase as a site plan: one page where each file is a bar drawn to scale, each folder a frame, and each
dependency a line judged by the rules you state. Switch between the tree as it is and one or more proposed trees, and
watch every file glide to its new place.

The tool holds no opinion on architecture. Layers, rings, modules with a public contract, ports and adapters, feature
slices: each is a few lines of config. With no config at all, it draws the tree as measured.

## Usage

```
/architecture-map
```

The skill walks through six steps: frame the question, measure the graph, declare the views, build and look,
report the numbers, publish.

## How it works

```
source tree ──extractor──▶ graph.json ─┐
                                       ├──build──▶ map.html
              map.config.json ─────────┘
```

| Piece | Holds |
|---|---|
| `graph.json` | What was measured: files, sizes, file-to-file links. Written by an extractor, never by hand. |
| `map.config.json` | How to read it: views, bands, rules, moves, files to create or split, the page's words. |
| `map.html` | One self-contained page. Publishable as a claude.ai artifact, or opened as a file. |

Extractors ship for Python and for JavaScript/TypeScript. Any other language goes through `from-pairs.ts`, which takes
`from to` pairs or a `madge --json` output. The scripts run on Bun and need no dependency.

## What the page shows

- The file tree and the plan side by side; a sheet for the selected file or folder.
- Per view, how many links are ok, need a contract, or break a layer, and which files carry the most.
- Between the tree as it is and a proposal, how many links placement alone fixes and how many it newly flags.
- Light and dark themes, phone width, reduced motion.
- Optionally, one opinion per folder from each reader (agree, to discuss, disagree, with a remark), when the page is
  published with the `db` and `user` artifact capabilities.

## Files

| Path | Role |
|---|---|
| `skills/architecture-map/SKILL.md` | The procedure. |
| `skills/architecture-map/references/config.md` | Every key of `map.config.json`. |
| `skills/architecture-map/assets/template.html` | The page; restyle it through its CSS tokens. |
| `skills/architecture-map/scripts/` | The extractors and the builder. |
| `skills/architecture-map/examples/` | A made-up shop with two views, to copy from. |

## Try it

```bash
cd skills/architecture-map
bun scripts/build.ts --graph examples/demo.graph.json --config examples/demo.config.json \
  --out /tmp/map-demo/map.html --preview /tmp/map-demo/preview.html
bunx serve /tmp/map-demo -p 8000
```

Then open `http://127.0.0.1:8000/preview.html`.

## License

MIT
