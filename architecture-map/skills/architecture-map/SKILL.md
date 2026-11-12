---
name: architecture-map
description: Build an interactive map of a codebase's architecture, every file drawn to scale and every dependency judged by the rules you state, with optional proposed trees to compare.
disable-model-invocation: true
---

# Architecture map

The map is a **site plan** of a codebase: each file is a bar drawn to scale, each folder a frame, each dependency a
line. It exists to answer one **question** about the structure. It stays trustworthy because everything on it is
either **measured** (the graph) or **declared** (the config); nothing is drawn by hand.

Four words carry the tool:

- **graph**: what was measured. Files, sizes, file-to-file links. A script writes it.
- **view**: one arrangement of those same files: the tree as it is, or a proposed tree. Switching views moves each file.
- **band**: a horizontal layer of a view. Band order is the direction dependencies may run.
- **verdict**: what a view's rules say of each link: ok, warn (ochre pencil), bad (red pencil).

The architecture style lives entirely in the config: bands express layers or rings, columns express modules or
features, overrides express any "A must not depend on B". The same base draws a layered monolith, ports and adapters,
feature slices, or a tree with no stated rule at all.

To calibrate, build the demo and open it before writing anything:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/architecture-map/scripts/build.ts \
  --graph ${CLAUDE_PLUGIN_ROOT}/skills/architecture-map/examples/demo.graph.json \
  --config ${CLAUDE_PLUGIN_ROOT}/skills/architecture-map/examples/demo.config.json \
  --out /tmp/map-demo/map.html --preview /tmp/map-demo/preview.html
```

[`examples/demo.config.json`](examples/demo.config.json) is a complete config to copy from: two views, layers, a
contract, an override, moves, files to create, files to split, shared opinions.

## 1. Frame the question

Write the question the map answers in one sentence, then the views that answer it:

| The reader asks | Views |
|---|---|
| What depends on what? | the tree as it is, no rules |
| Where do we break our own rules? | the tree as it is, with the rules the project already claims |
| What would this reorganisation fix, and cost? | the tree as it is, plus one view per proposal |

A proposed view is a hypothesis: say so on the page with `note`.

Done when the question and the list of views are written and match what the user asked for.

## 2. Measure the graph

Run the extractor for the language from the repository, then keep `graph.json` beside the config:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/architecture-map/scripts/extract-python.ts path/to/package --out graph.json
bun ${CLAUDE_PLUGIN_ROOT}/skills/architecture-map/scripts/extract-js.ts . --alias '@/=src/' --out graph.json
bun ${CLAUDE_PLUGIN_ROOT}/skills/architecture-map/scripts/from-pairs.ts pairs.tsv --root src --out graph.json   # any other language
```

Each script documents its options under `--help`. For a language with no extractor, get file-to-file dependencies
from the ecosystem's own tool and shape them into pairs; `from-pairs.ts` does the rest.

Done when the file and link counts are stated, the links of three files are checked against their source, and every
line the extractor printed about unparsed files or unresolved imports is explained.

## 3. Declare the views

Build once with no config to see the raw shape, then write `map.config.json`. Every key is in
[`references/config.md`](references/config.md); read it before writing rules or moves.

- The tree as it is: its bands, and the rules the project states about itself. Find them in its architecture docs,
  lint config and architecture tests, and cite where each rule comes from when reporting.
- A proposal: `moves` for where each file goes, `new` for files to create, `splits` for files to cut later, and a
  `role` sentence for every proposed folder. A proposal moves files and keeps their names, so it previews a
  mechanical move.
- `strings`: every word of the page, in the reader's language.

Done when `build.ts` prints no `note:` line, every band and every proposed folder has a role, and the page's words
are in the reader's language.

## 4. Build and look once

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/architecture-map/scripts/build.ts --graph graph.json --config map.config.json \
  --out dist/map.html --preview dist/preview.html
```

Serve `dist/` over a local HTTP server and open `preview.html`. Look at it in light, in dark and at phone width;
switch views; open one file and one folder.

Done when the console is clean, links are drawn at rest, files glide on a view switch, and the headline numbers equal
the build report.

## 5. Report the numbers, then the picture

The build report is the finding. State it as measured fact before sharing the page:

- per view, how many links are ok, warn, bad, and which files carry the most links to fix;
- between the first view and a proposal, how many links placement alone fixes and how many it newly flags. The page
  shows both under "what placement alone changes".

## 6. Publish, when someone else will read it

Publish `dist/map.html` with the Artifact tool. The page is private until its owner shares it.

A view with `"feedback": true` collects one opinion per folder from each reader. It needs two capabilities declared
at publish; load the `artifact-capabilities` skill first, then pass:

```json
{"db": {"rules": [{"path": "opinions", "read": "view", "write": "owner"},
                  {"path": "opinions/{self}", "write": "interact"}]},
 "user": {"scopes": ["profile"]}}
```

Each reader writes only `opinions/<their id>`; everyone admitted reads all of them. Readers need Contributor access to
write. Verify once after the first publish: write a probe document as the owner, read it at the `view` level, confirm
a write at the `interact` level is refused, delete the probe. Read the opinions back later with the artifact's data
tool, collection `opinions`.

Handed over as a file instead, the page works the same and the opinion block states that it is unavailable.

## Restyling

The look is a drafting sheet: tracing paper in light, cyanotype in dark, verdicts in pencil. Keep its grammar (bars to
scale, frames for folders, colour only for verdicts) and change its skin through the `css` and `fonts` keys, which
override the tokens declared at the top of [`assets/template.html`](assets/template.html). Edit the template itself
for a new behaviour, then rebuild the example to check it still draws.
