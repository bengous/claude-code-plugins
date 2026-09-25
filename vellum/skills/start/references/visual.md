# Visual artifacts

A plan is Markdown. A diagram earns its place when it shows several layers, interactions or states faster than text would: an architecture, a sequence, a state machine. Not on every section, and never as the only place a fact lives. Mermaid in the plan for diagrams; an HTML file next to the plan for a screen, listed in the plan by path and kept after implementation for verification.

## Mockups

A rough HTML page of the actual screen settles what three paragraphs would only prolong. Plain HTML and CSS, no framework, real labels, the states that matter (empty, loading, error). One file per screen; when the reviewer chooses between options, the options sit side by side in that file.

When the session lists the `artifact-design` skill, load it before the first mockup and apply the design fundamentals it gives for every artifact on top of the paragraph above; where the two disagree, the paragraph above wins. That skill is written for pages published on claude.ai, and three of its rules do not hold here, since Vellum serves the mockup file as written, in a sandboxed frame:

1. A mockup is a complete HTML document, with its own `<!doctype html>`, `<head>` and `<body>`. Nothing wraps it, and a page without a doctype renders in quirks mode.
2. No `window.claude` runtime exists here, so none of its capabilities do.
3. claude.ai's publish rules do not apply: its CDN allowlist, its safe-area padding, the title, icon and description it asks for, and publishing itself. The mockup stays a file next to the plan, never an Artifact.

Without `artifact-design` in the session, the paragraph above is the whole guidance.

## Choices in a mockup

When the reviewer is to choose between options side by side, mark them: a click on Choose then adds the option to the reviewer's draft, marked in the mockup, and it reaches you with their comments, in the batch's `## Choices`.

```html
<section data-vellum-decision="layout">
  <article data-vellum-option="sidebar">
    <h2>Sidebar</h2>
    … <button data-vellum-choose>Choose</button>
  </article>
  <article data-vellum-option="tabs">
    <h2>Tabs</h2>
    … <button data-vellum-choose>Choose</button>
  </article>
</section>
```

- `data-vellum-decision` on the element that holds the options, one key per decision in the file. The reviewer keeps one option per decision: choosing another replaces the first.
- `data-vellum-option` on each option, a word you will know again when it comes back: `sidebar`, not `b`.
- `data-vellum-choose` on a button inside the option, after the option's heading: the batch describes that button by the heading before it.

## Flows and states

A sequence with more than three actors, or a state machine, can be a Mermaid block in the plan, with the same facts stated in the text next to it. When the order of steps already tells the story, a numbered list beats a diagram.

## What stays text

Program design defaults to pseudocode (types, signatures, call stacks, file trees, the formats in `program-design.md`) because it is precise and diffable. Add a diagram on top when the interaction between components is the point; keep the signatures next to it.

## Rendering

The plan file is what the harness renders. A mockup opens in a browser. Do not inline a mockup into the plan.
