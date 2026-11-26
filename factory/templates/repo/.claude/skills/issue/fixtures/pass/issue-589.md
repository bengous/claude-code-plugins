The `issue` skill writes *Evidence* and *Hints* that point at the code to change, and a *Done when* of checkboxes that often name nothing testable. The agent that takes the issue follows the hint instead of looking.

**Done when** an issue has this shape and no other section. The section set, the caps and the refusals are the contract; the wording, the form of the visual and where the check lives are free. Every situation below is a test a cloud session can run.

```diff
- ## Problem
- ## Evidence       anchors into the code to change
- ## Hints          where to start, traps
- ## Done when      checkboxes
- ## Out of scope
+ <title: the state once done, not the action>
+ Problem          1 to 2 lines: what is observed and what it costs, no cause in the code
+ Done when        the expected result as a visual: terminal sessions per situation,
+                  a mockup of the states, a timeline, a chart with the target,
+                  or a Today / Expected table for a plain bug;
+                  the visual lists its situations, one per row or panel;
+                  one line on what is contract and what is free;
+                  at least one situation for no regression; each situation testable
+ Not this         3 lines at most
+ Author's leads   folded, facts only, never a fix
+ <footer: the model that wrote it>
```

| Situation | Expected |
|---|---|
| fixture drafts for a bug, a feature, a UI change and a guard | the check passes each |
| a draft with `Fix:`, `Possible direction` or a numbered plan | the check refuses it and names the line |
| a question mark outside code and URLs | refused |
| a Done when visual that lists no situation | refused |
| a `?` inside a code block or a URL, or a draft already in the shape | passes: no regression |
| a visual over 40 lines | the skill moves it to an issue artifact the body names; the artifact holds no script |
| a repository sets its own caps | the check uses them, from the same settings as the `pr` check of #588 |
| `github-flow/README.md` | describes the `issue` skill as it now behaves |

**Not this** the `pr` skill (#588), the factory's copy of the skills (#590).

<details><summary>Author's leads</summary>

- `gh issue artifact create` resolves the issue through GraphQL, closed to a cloud session; `gh api repos/{o}/{r}/issues/{n}/artifacts` answers in REST.
- A published test (Kesin11, zenn.dev) reports that no script runs in an HTML issue artifact; `:checked`, `<details>`, SVG and data URI images do. Not confirmed by GitHub's docs.
- `github-flow/scripts/plan-lint.ts` refuses "to be decided" in a plan's prose.

</details>

<sub>Written by Claude Opus 5.5</sub>

