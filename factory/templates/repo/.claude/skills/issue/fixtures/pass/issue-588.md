Bodies written with `github-flow:pr` run long and end on open points the next agent loops on: #582 holds 2,168 words, 1,000 of them in *Checks* and 357 in nine *Left open* points.

**Done when** a body has this shape and no other section. The section set, the caps and the refusals are the contract; the wording, the choice of view and where the check lives are free. Every situation below is a test a cloud session can run.

```diff
- <two lines>
- ## Before / After
- ## Decisions        11 bullets
- ## Checks           review recap, commands, a 28-row mutant table
- ## Left open        9 points
+ Closes #N.
+ Why        one sentence
+ Danger     one-way or two-way door · reach: what breaks if the change is wrong
+ Start at   the test or the contract; "Read in this order" when the change crosses modules
+ <one view: pseudocode, call tree or file tree as a diff; Mermaid for a topology>
+ Proof      the issue's situations, before → after
+            UI: two stills for a state, a still then a clip for a transition,
+            a protocol line (build, viewport, page, action),
+            the e2e test that asserts what the clip shows, 3 clips at most
+ Decided    3 facts at most, never a question
+ Checks     what ran, with its numbers; nothing about what did not run
+ <footer: the model that wrote it>
```

| Situation | Expected |
|---|---|
| fixture bodies for a fix, a feature, a UI change and a cross-module change | the check passes each |
| a body with a question, *Ask*, *Left open*, *Not shown*, *Known gaps*, a review recap, or a line on what did not run | the check refuses it and names the line |
| more than 120 words of prose outside views, tables and code | refused |
| a clip with no protocol line or no e2e test named | refused |
| a `?` inside a code block, or a body already in the shape | passes: no regression |
| a repository sets its own caps | the check uses them; the defaults above apply otherwise |
| the `pr` skill and its check copied together into another repository | the check runs there, with no import outside the copy |
| `CLAUDE.md` and `AGENTS.md` | hold no rule on how to write a pull request body; the `pr` skill is the only place |

**Not this** the `issue` skill (#589), the factory's copy of the skills (#590).

<details><summary>Author's leads</summary>

- `github-flow/scripts/plan-lint.ts` is a check that a hook and a CLI share, with findings as `<file>:<line>: <check>: <message>`.
- `github-flow/skills/pr/references/views.md` and `video.md` hold the views and the clip recipe.
- The rules to remove today: the *Pull request body* section of `CLAUDE.md`, and the sentence of `AGENTS.md` that names a behaviour "as not played in a session" under **Checks**.

</details>

<sub>Written by Claude Opus 5.5</sub>

