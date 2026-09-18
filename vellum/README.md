# vellum

Write a plan the way its reviewer reads it, then review it in the browser. The skill orders the plan by what the reviewer is most likely to change and buries the mechanics; the hooks module holds a planning mode of its own: `/vellum:start` enters it, Claude writes the plan and its mockups in a working directory, the reviewer comments them in a page or approves, and the answer reaches Claude as a prompt.

Replaces `plan-frontiers` and `software-craft:thorough-plan`.

## Requirements

- Claude Code with function hooks, launched with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` until they ship publicly. Without the flag the hooks module does not load: the skill still writes a plan under `plans/<date>/<slug>/`, but there is no mode, no page and no `mcp__vellum__submit` tool; use the native plan mode for that session.
- `bun` on the PATH: the review server is a Bun script. Claude Code installs the plugin's dependencies (`preact`, `remark`, `rehype-highlight`, `mermaid`, `diff`) at its cache from `package.json` and `bun.lock`.
- A browser: Chromium or Firefox, recent. The page uses the CSS Custom Highlight API.
- Managed settings without an `allowedMcpServers` key. Where that key is set at all, empty included, Anthropic's `sec-default` refuses a user-tier `$.tool.register` by name: `mcp__vellum__submit` does not exist on that machine and the mode cannot be entered. The skill still writes a plan.

## Skill

`/vellum:start` triggers itself when a design choice is open, a change crosses several modules or interfaces, or a refactor reshapes a contract. Three moves:

1. Size the ceremony. A one-sentence diff gets no plan. A fuzzy idea gets a throwaway first, after the few questions that pin down what it must show.
2. Settle the open choices in a grill, in the review page. Claude suggests one with `mcp__vellum__grill_suggest`; you start it, or not. Only a question whose answer changes the architecture, an interface or the scope is asked; the rest becomes a recorded assumption.
3. Write the plan to `plan.md`, ordered by probability of revision: decisions, interfaces, files, slices with their check, out of scope, then mechanics. Then call `mcp__vellum__submit`.

References, loaded one at a time: `program-design.md` (signatures, call-stack and file trees, command interfaces, contracts), `slices.md` (vertical order, sizing, implementation notes), `visual.md` (when a mockup or a diagram earns its place).

## Review in the browser

`/vellum:start` enters the mode. The hooks module creates `plans/<date>/wip-<sid8>/`, tells Claude to put the plan and its artifacts there, starts one review server per session on `127.0.0.1` (it exits on its own once the session's heartbeat stopped and no tab shows the page; if it dies, the module revives it on the same port and token, so the page reconnects by itself) and opens the page. While the mode is live, `Edit`, `Write` and `NotebookEdit` under the project and outside the working directory are refused with a reason Claude reads; inside it they pass without a prompt; a path outside the project is no change to the codebase and follows the session's own permission flow, so the session's scratchpad passes there without a prompt; a lock that fails refuses the call rather than letting it past; every other tool follows the session's own permission flow, and a Bash command that a settings allow rule would approve asks instead. The native plan mode is untouched and stays available for a plan that needs no review page.

1. The page lists the working directory's renderable files from the start: Markdown, HTML in a sandboxed iframe, images. `[` and `]` move between documents; an artifact can sit beside the plan. A comment sent before the first version is written to `.review/v0.feedback-<n>.md` and reaches Claude as a prompt at its next idle: it revises the file and goes on.
2. Claude writes `plan.md` at the directory's root and ends its turn: the module submits the text, saved as `.review/vN.md`, and the page shows it. The same text keeps its version, so a turn that only asks a question opens none. `mcp__vellum__submit` submits before the turn ends; after a feedback, that explicit call is a new version even with the same text.
3. From the second version on, the bar shows beside the version how many lines were added and removed, and **Changes since vN-1** marks them on the rendered plan: a green bar on an added or changed block, the removed lines folded in a red block above what replaced them. The marks are off at every load, and comments work with them on.
4. Comments: select text in a Markdown document, or Pinpoint a block, a code block, a table cell or a diagram; in an HTML mockup, Pinpoint an element and Ctrl+click to add another. The same popover takes a quick label (Clarify, Verify, Too much, Missing check), with a detail or without, and **Delete this**; the feedback prints each as a sentence Claude acts on. The box under the comments takes a general comment. Code blocks are coloured and Mermaid blocks are drawn.
5. **Edit** opens the plan's Markdown source on the block you were reading. **Done** renders your text, marked "edited, not sent", and moves the comments already made to their new lines. The edit leaves with your next decision, as the next version: `.review/vN+1.md` and `plan.md` hold your text, and `vN.md` stays what Claude submitted. An edit made on a version Claude has since replaced is refused, and the page says so rather than overwrite the revision.
6. **Send feedback** writes `.review/vN.feedback.md` (path, then lines and quote or selector and text, then the comment, for each) and submits a prompt: Claude reads the file, revises, and `vN+1` is submitted when its turn ends. With an edit the file says first that the reviewer edited `plan.md` and that those edits stay; an edit alone, with no comment, can be sent.
7. **Approve** renames the directory to the slug of the plan's title (`-2` on collision, `plan` without a title), rewrites the links in every text file of it, and submits a prompt naming the final directory. The mode closes and the lock lifts. **Approve with notes…** takes a note for Claude: it is kept in `.review/vN.notes.md`, never in the plan, and the prompt says to read that file first, so Claude reads it before it acts. An approval that carries an edit writes that file too, to tell Claude to read `plan.md` again. With unsent comments, either button first warns that approving discards them; with a grill open, that approving ends it.
8. The unsent comments and the unsent edit are saved in `.review/draft.json` at every change. A reload restores them, in any browser, since the file is the server's; a decision that lands removes it.

### A grill

The **Grill** button opens a grill on a subject you type; when Claude suggested one, the button is lit and a banner carries its reason and its subject, which you may change. Claude never opens a grill. Each one is a file of the working directory, `grill-<n>.md`, listed with the other artifacts and carried to the final directory by the approval. It keeps the rounds: Claude's questions, your answers beside them, and what Claude says in the turns of the grill. A command of the session (`/vellum:start`, `/clear`) is kept as an event line; what you type in the terminal is not the grill's.

Claude asks a round with `mcp__vellum__grill_ask`. The page draws each question as a card: its number, its topic, the question, and the recommendation with **Take it**, which fills the field with `As recommended.` and sends nothing: Claude wrote the recommendation, so its text never goes back to it. **Send answers** closes every open question: a field left empty takes the recommendation, marked as taken by default. Your reply is written in the round of its questions, and Claude receives it once its turn ends, under `Reviewer:`: your note first, then the answers you typed, never a default. Every reply goes, in order, whatever Claude said meanwhile. While a grill is open the line under Claude Code's prompt says `grill open, answer in the page`: what you type in the terminal is answered there and is not the grill's. A question stays open until you send, whatever happens in the session meanwhile. **End grill** closes the file with a footer and tells Claude, in one sentence that names the file, that the grill ended; `/vellum:stop` and the approval close it too, the approval on the server, whether or not the session is still there. While a grill is open the review is held: no version is recorded, `mcp__vellum__submit` is refused with the reason, and Send feedback is greyed; ending the grill lifts it. While the mode is live `AskUserQuestion` is refused: the page is your one channel. One grill is open at a time.

`/vellum:stop` leaves the mode without a plan; the directory is kept. `/clear`, and a `/resume` that lands in another session, suspend it: timers stopped, the session's record kept, so resuming that session later finds its directory. The status bar reads `vellum: planning`, then `vellum: plan vN under review`.

## Agent

`plan-reviewer` reads a plan and its artifacts, read-only, and reports Approved or Issues found with a verdict: overengineered, underengineered or right. The skill calls it for a large change or a plan no human will read; call it yourself with the plan path otherwise.

## What it does to the session

The plugin installs a hooks module that refuses writes and spawns a process. These two tables say what it hooks and what it calls, nothing more.

### What it hooks

| Hook | Matcher | What it does |
|---|---|---|
| `session.start` | | Registers the `submit`, `grill_suggest` and `grill_ask` tools, and picks the mode back up when the stored server still answers. |
| `skill.prompt` | `skill=vellum:start` | Enters the mode: reaches or starts the server, then appends the working directory and the page's link to the skill's text. |
| `skill.prompt` | `skill=vellum:stop` | Leaves the mode and says which directory is kept. |
| `command.run` | `command=clear\|resume` | Suspends the mode after the command ran, when the session id changed: timers stopped, the record kept. |
| `tool.check` | | The lock. Its `.catch` denies whatever the failure, so a hook that throws or overruns cannot open it. |
| `tool.call` | `tool=mcp__vellum__submit` | Gates the plan and names the version, without running a tool. |
| `tool.call` | | Serves `mcp__vellum__grill_suggest` and `mcp__vellum__grill_ask`, and refuses `AskUserQuestion` while the mode is live; every other call passes on. |
| `prompt.submit` | | While the mode is live, hands a command of the session to the open grill's transcript as an event, Vellum's own relays left out, then passes every prompt on unchanged. |
| `turn.start` | | Notes whether the turn was started by one of Vellum's own relays, from the origin `prompt.submit` saw. |
| `turn.complete` | | Gates `plan.md` after a main-loop turn answered while the mode is live; an unchanged text is kept. Hands the main loop's final text to the open grill's transcript, which keeps it when a relay of Vellum started the turn. |

### What it calls on `$`

| Call | What for |
|---|---|
| `$.tool.register` | The `submit` tool and the two grill tools, at the session's start. |
| `$.session.id` | Which session the mode belongs to; a `/clear` mints a new one. |
| `$.session.cwd` | Where the session runs now, to resolve a relative path the lock reads. |
| `$.store.get`, `$.store.set`, `$.store.delete` | The session's server and what the poll already relayed, so a module reload repeats neither. |
| `$.http.fetch` | Every call to the review server, with the token header. |
| `$.process.run` | Spawns the detached server, `bun src/core/server/cli.ts start`, and revives a dead one on its port and token. |
| `$.clock.every` | The poll, once a second, the heartbeat that keeps the server alive, and the slow retry while the server is lost. |
| `$.prompt.submit` | Hands Claude a drafting batch, a feedback, the approval or a grill round the reviewer wrote, once the session is idle. |
| `$.ui.status` | The line under the prompt: planning, then the version under review; a grill that is open; a server that is lost, or a working directory that is gone. |
| `$.ui.log` | Errors only: a server that did not start, a poll that failed, a prompt another plugin dropped. |

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate vellum` prints both lists from the module's source; these tables are that output in prose.

Development: `bun install --cwd vellum`, `bun test vellum`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate vellum`, then a session with `--plugin-dir vellum`; see `docs/plugin-testing.md` at the repository root. The map of the code is `AGENTS.md` § Shape in this directory, the one place the tree is drawn; the drawings and the decisions behind it are `docs/architecture.md`.

## Sources

Thariq Shihipar (Anthropic) on ordering a plan by what the reviewer will tweak and on artifacts passed to a fresh session; Dex Horthy (HumanLayer) on program design formats and vertical slices; the OpenAI Codex plan-mode prompt on assumptions and on what to omit; Boris Cherny on the overengineered / underengineered verdict; Jesse Vincent's superpowers on the plan reviewer; Plannotator for the review ideas, not the code. Collected September 2026.

## License

MIT

## Author

Augustin BENGOLEA <bengous@protonmail.com>
