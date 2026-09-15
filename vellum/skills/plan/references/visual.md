# Visual artifacts

A plan is Markdown. A diagram earns its place when it shows several layers, interactions or states faster than text would: an architecture, a sequence, a state machine. Not on every section, and never as the only place a fact lives. Mermaid in the plan for diagrams; an HTML file next to the plan for a screen, listed in the plan by path and kept after implementation for verification.

## Mockups

A rough HTML page of the actual screen settles what three paragraphs would only prolong. Plain HTML and CSS, no framework, real labels, the states that matter (empty, loading, error). One file per screen; when the reviewer chooses between options, the options sit side by side in that file.

## Flows and states

A sequence with more than three actors, or a state machine, can be a Mermaid block in the plan. State the same facts in text next to it: a diagram supplements the prose, it is never the only place a fact lives. When the order of steps already tells the story, a numbered list beats a diagram.

## What stays text

Program design defaults to pseudocode (types, signatures, call stacks, file trees, the formats in `program-design.md`) because it is precise and diffable. Add a diagram on top when the interaction between components is the point; keep the signatures next to it.

## Rendering

The plan file is what the harness renders. A mockup opens in a browser. Do not inline a mockup into the plan.
