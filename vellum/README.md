# vellum

v1.0.0

Write a plan the way its reviewer reads it, then review it in the browser. The skill orders the plan by what the reviewer is most likely to change and buries the mechanics; the hooks module opens the plan and its mockups in a page at `ExitPlanMode`, where the reviewer comments the text or approves, and hands the answer back to Claude as a prompt.

Replaces `plan-frontiers` and `software-craft:thorough-plan`.

## Requirements

- Claude Code 2.1.272 or later, launched with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` until function hooks ship publicly. Without the flag the skill still runs, artifacts go to `plans/<date>/<slug>/`, and `ExitPlanMode` shows the terminal dialog as in plain plan mode.
- `bun` on the PATH: the review server is a Bun script. Claude Code installs the plugin's dependencies (`preact`, `remark`) at its cache from `package.json` and `bun.lock`.
- A browser: Chromium or Firefox, recent. The page uses the CSS Custom Highlight API.

## Skill

`/vellum:plan` triggers itself when a design choice is open, a change crosses several modules or interfaces, or a refactor reshapes a contract. Three moves:

1. Size the ceremony. A one-sentence diff gets no plan. A fuzzy idea gets a throwaway first, after the few questions that pin down what it must show.
2. Settle the open choices in question rounds, each question with a recommended answer. Only a question whose answer changes the architecture, an interface or the scope is asked; the rest becomes a recorded assumption. `assume` closes a round.
3. Enter plan mode and write the plan ordered by probability of revision: decisions, interfaces, files, slices with their check, out of scope, then mechanics.

References, loaded one at a time: `program-design.md` (signatures, call-stack and file trees, command interfaces, contracts), `slices.md` (vertical order, sizing, implementation notes), `visual.md` (when a mockup or a diagram earns its place).

## Review in the browser

When the skill is invoked, the hooks module creates `plans/<date>/wip-<sid8>/` and tells Claude to put the plan's artifacts there. It starts one review server per session, on `127.0.0.1`, that exits 90 s after the session ends.

At `ExitPlanMode`:

1. The plan is saved as `.review/vN.md` in the working directory and the page opens (a connected tab is reused). The call is refused with "Plan vN is open for review in the browser"; Claude ends its turn.
2. The page lists the plan and the files it links: Markdown, HTML in a sandboxed iframe, images. `[` and `]` move between documents; an artifact can sit beside the plan. Select text in the plan or a linked Markdown to comment it; the box under the comments takes a general comment.
3. **Send feedback** writes `.review/vN.feedback.md` (path, lines, quote and comment for each) and submits a prompt: Claude reads the file, revises, calls `ExitPlanMode` again with `vN+1`.
4. **Approve** submits a prompt asking Claude to call `ExitPlanMode` again. That call is allowed: the directory is renamed to the slug of the plan's title (`-2` on collision, the plan file's name without a title), links are rewritten in the plan and in every text file of the directory, and the session leaves plan mode.

The status bar reads `vellum: plan vN under review` while the page waits. A subagent's `ExitPlanMode`, or one outside `/vellum:plan`, goes to the terminal dialog.

## Agent

`plan-reviewer` reads a plan and its artifacts, read-only, and reports Approved or Issues found with a verdict: overengineered, underengineered or right. The skill calls it for a large change or a plan no human will read; call it yourself with the plan path otherwise.

## Layout

```
hooks/register.ts     the hooks module: skill.prompt and classic.PermissionRequest on ExitPlanMode
src/cli.ts            `start` spawns `serve` detached; `serve` is the review server
src/server/           routes, review state, the page bundled by Bun.serve from ui/index.html
src/workspace/        plans/<date>/ directories, versions, slug, rename and link rewrite
src/feedback/         the feedback file Claude reads
ui/                   the Preact page: document list, decision bar, comments, text anchoring
plugins/              rendering plugins (markdown, html, image); a third party sends a PR
types/claude-code.d.ts the function hooks contract, written by `/plugin-types vellum/types`
```

Development: `bun install --cwd vellum`, `bun test vellum`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate vellum`, then a session with `--plugin-dir vellum`; see `docs/plugin-testing.md` at the repository root.

## Sources

Thariq Shihipar (Anthropic) on ordering a plan by what the reviewer will tweak and on artifacts passed to a fresh session; Dex Horthy (HumanLayer) on program design formats and vertical slices; the OpenAI Codex plan-mode prompt on assumptions and on what to omit; Boris Cherny on the overengineered / underengineered verdict; Jesse Vincent's superpowers on the plan reviewer; Plannotator for the review ideas, not the code. Collected September 2026.

## License

MIT

## Author

Augustin BENGOLEA <bengous@protonmail.com>
