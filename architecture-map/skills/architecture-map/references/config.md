# `map.config.json`

Every key is optional. With no config, `build.ts` draws one view: the tree as measured, one column per top-level
folder, judging nothing. A complete two-view config is [`../examples/demo.config.json`](../examples/demo.config.json).

## The graph

Written by an extractor, read by `build.ts`, never edited by hand:

```json
{"root": "myapp", "unit": "lines",
 "nodes": [{"path": "billing/api.py", "size": 248}],
 "edges": [["billing/api.py", "kernel/db.py"]]}
```

`path` is relative to the extractor's ROOT. An edge reads "the first file depends on the second". Any tool that
yields these two lists works; `scripts/from-pairs.ts` converts pair lists and `madge --json`.

## Page

| Key | Meaning |
|---|---|
| `name` | The `<title>`: a short name for the tab and the gallery. |
| `title` | The headline on the page. |
| `root` | Prefix shown before every path. Default: the graph's root plus `/`. |
| `unit` | What `size` counts. Default: the graph's unit. |
| `lang` | Locale for numbers (`fr`, `en`). |
| `start` | Id of the view shown first. Default: the last view. |
| `note` | One sentence under the legend, for example that a proposal is not a decision. |
| `links` | `[{"label", "href"}]`, shown under the legend. |
| `strings` | Overrides for any word the page shows. The full list with English defaults is the `T` object at the top of the script in `assets/template.html`. Write them in the reader's language. |
| `fonts` | A Google Fonts stylesheet URL replacing the default one. |
| `css` | CSS appended after the base styles. The tokens to override are the custom properties on `:root`, in three blocks: light, dark by system preference, dark by `data-theme`. |

## Shaping the file set

Applied once, before any view, on the graph's paths.

| Key | Meaning |
|---|---|
| `drop` | `[{"match": glob, "maxSize": n}]`: leave these files out, with their links. `maxSize` limits it to small files (empty `__init__.py`). |
| `collapse` | `[{"match": glob, "into": path, "label": text}]`: draw many files as one tile at `into` (generated code, migrations). Their sizes add up and their links are kept on the tile. Two rules with one `into` share the tile; an `into` that names a file of the graph stops the build. |
| `splits` | `{path: [text, ...]}`: a file planned to be split, with the pieces. Drawn dashed; the pieces show on its sheet. |

## Views

`views` is a list. Each view arranges the same files and judges the same links by its own rules. The first view is
the reference the others are compared to ("what placement alone changes").

| Key | Meaning |
|---|---|
| `id`, `label` | Identifier, and the name on the switch. |
| `moves` | `[[glob, destination], ...]`, first match wins; an unmatched file stays where it is. A destination ending in `/` is a folder: the file keeps whatever follows the pattern's fixed prefix (`["src/core/**", "kernel/"]` keeps sub-folders). `"./"` is the root. Any other destination is the file's full new path. |
| `new` | `[{"path", "why"}]`: files this view would create. Drawn hatched, with no size and no links. |
| `bands` | The horizontal layers, top to bottom. See below. Without it: one band, one column per top-level folder. |
| `rules` | How this view judges links. See below. Without it the view judges nothing. |
| `rulesText` | Sentences shown as "the rules of this view". Default: written from `rules`, overrides first. |
| `roles` | `{folder path: sentence}`: what each folder is for, shown on its sheet and as a tooltip in the tree. |
| `note` | A sentence shown under the rules. |
| `feedback` | `true`: readers give an opinion per folder of this view. Needs the page published with the `db` and `user` capabilities; otherwise the block says it is unavailable. |

### Bands

```json
{"label": "modules", "dirs": ["billing", "catalog"], "columns": true, "rootLabel": "public contract", "role": "One folder per business module."}
```

- `dirs`: path prefixes in this view. A file belongs to the band holding the longest prefix of its path. `"."` holds
  the files at the root. Files matching no band land in an extra last band, and `build.ts` prints a note.
- `columns`: draw each folder of `dirs` as a framed column. Use it for peers (modules, features, services).
- `rootLabel`: the name of the lot holding the files directly in a `dirs` folder. Default: "at the root".
- Band order is meaning, not decoration: with `"layers": true` it is the direction dependencies may run.

### Rules

```json
"rules": {
  "layers": true,
  "contracts": [{"band": "modules", "files": ["api.py", "index.ts"], "verdict": "warn"}],
  "overrides": [
    {"from": "*/domain/**", "to": "*/infra/**", "verdict": "bad"},
    {"from": "tools/**", "verdict": "ok"}
  ]
}
```

A link gets the first verdict that applies, in this order:

1. `overrides`, in list order. `from` and `to` are globs on the paths in this view; a missing one matches everything.
   This is the general tool: any rule an architecture states as "A must not depend on B" (ports and adapters, clean
   layers inside a feature, a forbidden shortcut) is one line here.
2. Two files of the same folder: ok.
3. Same band, two different `dirs` folders: with a contract on that band, ok only when the target is one of `files`
   directly in its folder, else the contract's verdict (default `warn`). Without a contract: ok.
4. Different bands, with `layers`: ok toward a band below, `bad` toward a band above.
5. Otherwise ok.

Verdicts are `ok`, `warn` (drawn ochre), `bad` (drawn red). Name them for the project in `strings`: `v1` and `v2` are
the plural phrases in the headline ("need a contract"), `s1` and `s2` the per-link labels ("via a contract").

## Globs

`*` stays inside one path segment, `**` crosses segments, `**/` also matches nothing, `?` is one character,
`{a,b}` is either. Globs always match the whole path.

## What `build.ts` prints

One line per view: links ok, warn, bad, files moved, and the files carrying the most links to fix. A line starting
with `note:` names something the config says that the graph does not back: a move or collapse that matched no file,
a split naming an unknown file, files outside every band. A path clash (two files moved onto one path), a contract
naming a band that does not exist, or a collapse onto an existing file stops the build.
