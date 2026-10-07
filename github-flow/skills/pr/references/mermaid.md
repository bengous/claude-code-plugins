# Mermaid in a PR body

GitHub draws a ` ```mermaid ` block of a PR body in a frame as wide as the PR column. A terminal and `gh pr view` show the source only, so a diagram that parses can still be unreadable once drawn. The traps below were measured on bengous/arbre-genealogique-bengolea-src#76, GitHub dark theme, Chrome; heights are those of the rendered frames.

## Layout

- **`flowchart TB` for a graph wider than a short chain.** An architecture graph drawn `LR` was scaled down to 180 px high, its labels unreadable. Its readable version, `TB` with none of the two traps below, rendered 1,270 px high. `LR` suits a short chain, and #76 kept its eight-node After architecture in `LR`; the length where `LR` stops reading is not measured.
- **No `subgraph`.** A `TB` graph with one subgraph for the scripts and one for the data files rendered, but its edges crossed the whole drawing.
- **No edge drawn only to say who reads what.** Five dotted edges into one node made the same drawing unreadable. The readers of a module go in a line under the view.
- **A data model goes `TB`.** Eight edges crossed one another in `LR` and read cleanly in `TB`.

## Encoding

- **Shape is a role,** the same across every diagram of the body: a stadium `id(["…"])` for a script or a command, a rectangle `id["…"]` for a file or a record, a rhombus `id{"…"}` for a choice or a union, a hexagon `id{{"…"}}` for a gate that blocks.
- **Colour is a status,** set with `classDef` and `class`: one colour for what is new, one for what fails or what the change removes from use, a dashed stroke for what is archived. Each class sets `fill`, `stroke` and `color` together; a fill whose text colour is left to the theme turns unreadable in one of them. These three read on both themes, dark on #76 and light on `views.md` of this plugin:

  ```text
  classDef new fill:#e2eef4,stroke:#1d5b78,color:#0f3346
  classDef hot fill:#fde8e6,stroke:#a3342b,color:#4a1510
  classDef archived fill:#efe9dd,stroke:#7a6a4f,stroke-dasharray:5 4,color:#3d3426
  ```

- **A one-line legend above the diagram** says what each colour and each shape stands for: `Red: read by verify on every push. Blue: new. Dashed: archived. Rounded: a script; rectangle: a file.`
- **`autonumber`** in a `sequenceDiagram` numbers the messages, so a line of the body can point at step 4.

## Syntax

The parser fails on these, and GitHub then shows an error box instead of the diagram:

- `end` cannot be a node id. Name the node otherwise and keep the word as its label: `done["end"]`.
- A label that holds `(`, `)`, `[`, `]`, `{` or `}` goes in double quotes: `load["getData()"]`.
- A double quote inside a label is `#quot;`.
- A line break inside a label is `<br/>`. A blank line inside a label breaks the block.

## Checking the render

Only a browser shows the drawing. On a private repository, only the user's logged-in browser session can open the PR. Each diagram is a frame served from another origin: a full-page screenshot leaves the ones outside the viewport blank. Scroll each into view and screenshot the viewport. Each fix is an edit of the body, a reload and a screenshot; after two rounds, *Left open* names the diagram that still does not read.
