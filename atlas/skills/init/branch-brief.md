# Brief: one branch of a first map

The session fills each `{…}` and hands this text to one Explore subagent per top-level branch.

---

Map one branch of the repository at `{repository root}`, read only: write no file, run nothing
that changes one. Return the text of a TypeScript file, `parts/{branch id}.ts`, which the session
writes into the map folder `{map folder}`.

The branch: **{branch id}**, "{label}": {responsibility}. Its paths: {paths}.

The other branches, which a link may name by their id: {other branch ids, each with its
responsibility}. The outside nodes, which a link may name too: {outside ids, each with what it is}.

## What a node is

A node is a responsibility: what one would replace on its own. A path is its `src`, never a node.
A container holds the parts of its responsibility as children, three to nine of them; a leaf is one
part one would swap whole, often one file or a few. Go as deep as the responsibilities nest, and no
deeper than the code shows: a first map leaves details to later. Tests, fixtures and generated
files are no nodes; they are cited where they show a claim.

`{map folder}/atlas.d.ts` holds the types and says what each field means and where it is allowed.
Read it first.

## The file

```ts
import type { Link, Node } from "../atlas.d.ts";

export const node = {
  id: "{branch id}",
  label: "Few words",
  sub: "its main paths",
  color: "{branch id}",
  brief: ["what it holds", "in three", "short items"],
  lead: "What it does, in one or two sentences. <cite>path/to/file.ts:12-30</cite>",
  src: "path/to/folder/",
  children: [
    {
      id: "{branch id}-part",
      label: "Few words",
      sub: "path/to/file.ts",
      color: "{branch id}",
      lead: "What it does. <cite>path/to/file.ts:40</cite>",
      io: [
        ["Receives", "what comes in, from whom <cite>path/to/file.ts:41</cite>"],
        ["Produces", "what goes out, to whom <cite>path/to/file.ts:58</cite>"],
      ],
      swap: "What to touch to replace or remove it. <cite>path/to/caller.ts:7</cite>",
      extend: "The way to grow it. <cite>path/to/file.ts:20-25</cite>",
      pitfalls: ["A trap the code shows. <cite>path/to/file.ts:66</cite>"],
      src: "path/to/file.ts",
    },
  ],
} satisfies Node;

export const links = [
  // path/to/file.ts:58
  { from: "{branch id}-part", to: "another-branch", label: "what moves" },
] satisfies readonly Link[];
```

- Every id is kebab-case and starts with `{branch id}-`, but the branch's own: ids are unique on
  the whole map, and other subagents write the other branches at the same time.
- Every node carries `label`, `sub` and `color: "{branch id}"`; a leaf answers the four questions
  where the code answers them: its contract (`io`), what replacing it touches (`swap`), how it
  grows (`extend`), its traps (`pitfalls`). A container carries `brief` and `lead`. Leave a field
  out rather than guess it.
- Every claim ends with `<cite>path:line</cite>` or `<cite>path:first-last</cite>`, the path from
  the repository root, naming the lines that show it; a file at the root with no dot in its name
  is cited from `./` (`<cite>./Dockerfile:3</cite>`), or it reads as no citation. One claim, one
  sentence, one citation at least. `src` names where the node lives, without lines.
- A link joins two nodes neither of which holds the other: inside the branch, or from this branch
  to another branch's id or an outside id. Its label says what moves along it in a few words. The
  line above each link, a comment, cites where the code makes that call.
- `couples` lists the ids that change when this node is replaced, `see` the ids worth reading next.
- `lead`, `io`, `swap`, `extend`, `pitfalls` and `why` are HTML, `<code>name</code>` for an
  identifier and `&lt;` for `<`, and carry the citations; `label`, `sub`, `brief`, `facts`,
  `kicker` and `src` are plain text, shown as written, markup included.
- The HTML fields take `code`, `cite`, `b`, `i`, `em`, `strong` and `br`, with no attribute:
  `check` refuses any other tag. Never copy markup from the repository's files into the map; a
  `<` quoted from them is written `&lt;`.

## What to return

1. The file, whole, in one `ts` block.
2. Doubts: each fact of the system left out because no line settled it, and each file another
   branch may own, with the node it belongs to and the lines read. The session turns each into an
   open point. A file left unread, with no claim resting on it, is no doubt.
3. Nothing else: no summary of the code.
