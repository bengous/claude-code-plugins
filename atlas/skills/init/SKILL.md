---
name: init
description: >
  Draw a first atlas map of the repository: inventory it, agree a tree of responsibilities with the user, explore each branch with a subagent, verify every cited line, and assemble a map folder that passes check. Commits nothing. Only the user runs it.
disable-model-invocation: true
argument-hint: "[map folder]"
allowed-tools:
  - Bash(bun --config=${CLAUDE_PLUGIN_ROOT}/child.bunfig.toml --no-env-file ${CLAUDE_PLUGIN_ROOT}/src/cli.ts *)
  - Read(~/.claude/plugins/cache/*/atlas/*/skills/init/*)
---

# atlas init

Draws a first map of the repository the session works in, into the map folder the argument names,
`docs/atlas` under the repository root when there is none. The map is a tree of responsibilities
with every claim citing the lines that show it; whatever no line confirms becomes an open point the
human answers. Nothing is committed: the human reads the map first.

Every command below runs from the repository root. `bun` takes the plugin's flags first, so that a
`bunfig.toml` or a `.env` of the repository loads nothing into it. The two briefs this text names
sit beside it: `${CLAUDE_PLUGIN_ROOT}/skills/init/branch-brief.md` and
`${CLAUDE_PLUGIN_ROOT}/skills/init/verify-brief.md`.

## 1. Inventory

```bash
bun --config=${CLAUDE_PLUGIN_ROOT}/child.bunfig.toml --no-env-file ${CLAUDE_PLUGIN_ROOT}/src/cli.ts inventory .
```

It prints JSON: `manifests` (what each package.json, pyproject.toml, go.mod, Cargo.toml, compose
file, Dockerfile, flake or Nix module and CI workflow states: names, scripts, entry points,
services, images), `dirs` (the directories of the top two levels, with file counts and languages),
`imports.edges` (approximate imports between those directories), `env.vars` (environment
variables read) and `skipped`. Read it with the repository's own README and agent instructions:
they say what the parts are for, which the inventory cannot.

## 2. Agree the tree

Propose the first level of the tree, then stop until the human agrees.

A node is a responsibility: what one would replace on its own. A path is its source, never a
level. The tree that copies the directories is the wrong one:

| Copies the directories (wrong) | Names the responsibilities (right) |
|---|---|
| `src/` > `api/`, `db/`, `utils/` | Takes orders: the checkout route, the order table, the stock update |
| `scripts/` | Deploys: the Dockerfile, the compose file, the CI job that ships |
| `tests/` | (no node: a test belongs to what it tests) |
| `lib/mail.ts` under `lib/` | Sends mail: the mail client and the outside provider it calls |

Show a table, one row per top-level branch, three to eight of them: its id (kebab-case, it prefixes
every id of its branch), its label (a few words), its responsibility in one line, and the paths it
will read, each path under one branch alone: a file two branches would read is drawn twice. List
apart the outside nodes: the clients and third-party services the system talks to,
each with an id and the side it stands on, "in" for what calls the system, "out" for what the
system calls. Take the human's changes; go on once they agree.

## 3. Scaffold the folder

```bash
bun --config=${CLAUDE_PLUGIN_ROOT}/child.bunfig.toml --no-env-file ${CLAUDE_PLUGIN_ROOT}/src/cli.ts new docs/atlas
```

It refuses a folder that is not empty: a map already there is shown with `/atlas:board`, and
changed through a draft, never by init. In `atlas.config.ts`, set `title` to the repository's name,
`palette` to one key per branch id plus `outside`, each a `{ light, dark }` pair of hex colours,
and `sources` to the repository the inventory read, as the path from the map folder up to its
root: `sources: { root: "../.." }` for `docs/atlas`. With it, `check` verifies every citation
against the files and a click on a citation shows its lines. Delete the template's nodes from
`map.ts`; step 5 writes it.

## 4. Explore each branch

Start one Explore subagent per top-level branch, all at once. Each one's prompt is
`branch-brief.md` with its placeholders filled. A subagent only reads: it returns the text of
`parts/<branch>.ts`, its doubts and the links it wants to other branches, and the session alone
writes the files. Write each part as returned, under `parts/` in the map folder.

## 5. Assemble

Write `map.ts`: it imports each part's `node` and `links` (types from `./atlas.d.ts` with
`import type`), and exports, `satisfies AtlasMap`, a root with `title`, a `lead` (what the system
does, cited), `facts` from the inventory (languages, runtime, how it ships; plain text, as the
panel shows a fact's markup as written), the branches in the
agreed order, then the outside nodes, which `map.ts` holds itself (`outside: true`, `side`,
`color: "outside"`); and every part's links. Then:

```bash
bun --config=${CLAUDE_PLUGIN_ROOT}/child.bunfig.toml --no-env-file ${CLAUDE_PLUGIN_ROOT}/src/cli.ts fmt docs/atlas
```

```bash
bun --config=${CLAUDE_PLUGIN_ROOT}/child.bunfig.toml --no-env-file ${CLAUDE_PLUGIN_ROOT}/src/cli.ts check docs/atlas
```

Fix what check reports in the parts until it passes: a link to an id no part holds goes to that
branch's own id, a duplicate id takes its branch's prefix.

## 6. Verify every citation

Start one Explore subagent per part, all at once, never the one that wrote it, with
`verify-brief.md` filled. Each returns a verdict for every citation. Then, for each verdict:

- confirmed: nothing to do;
- another line: correct the citation;
- unconfirmed: remove the claim from the panel, or the part of it the lines do not show, and
  add to its node an open point,
  `open: [{ id, text }]`, whose id is the node's id and a few kebab-case words, unique on the map,
  and whose text states the fact left unsettled, never a step to take. Once the part is saved,
  write what is missing as the point's first entry, one point at a time:

```bash
bun --config=${CLAUDE_PLUGIN_ROOT}/child.bunfig.toml --no-env-file ${CLAUDE_PLUGIN_ROOT}/src/cli.ts reply docs/atlas <open id> --as agent "<what is missing: the lines read, what was not found there>"
```

A doubt a branch subagent returned is an open point the same way. Run `fmt` and `check` again until
check passes.

## 7. Hand over

Tell the human to run `/atlas:board docs/atlas` to open the map, and say in a few lines: the
number of nodes and links, the open points, which
`bun --config=${CLAUDE_PLUGIN_ROOT}/child.bunfig.toml --no-env-file ${CLAUDE_PLUGIN_ROOT}/src/cli.ts check docs/atlas --open`
lists, and every place where the procedure needed a judgement of yours. Offer, without writing
them, the map's rules for the repository's agent instructions: where its facts come from (the
paths it cites), a change to a component updates the map in the same commit, and a draft of the
map passes check before it is adopted.

With a map folder other than `docs/atlas`, every command above takes that folder instead.
