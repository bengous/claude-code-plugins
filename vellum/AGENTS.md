# Vellum

A Claude Code plugin: `/vellum:start` enters a mode the hooks module holds, where Claude
writes `plan.md` and calls `mcp__vellum__submit`; the plan and its artifacts open in the
browser, and the reviewer's answer reaches Claude as a prompt. `/vellum:stop` leaves the mode.
Function hooks, early access: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## Shape

Hexagonal with a functional core: two hexagons (the hooks module, the server) and a page.

```
hooks/hooks.json               Claude Code's folder: it names the hooks module, nothing else lives there
skills/start, skills/stop      the way in and the way out
src/core/engine/               the engine adapter: register.ts spells `$`, the rest takes a `Host`
        │ HTTP, token header, down; the server's stdout, up
src/core/server/adapters/      http/routes.ts, http/serve.ts, fs.ts, draft.ts, browser.ts, vellum-build.ts: every IO
src/core/server/app/review.ts  the use case: read, decide, apply
src/core/server/domain/        pure, no IO: paths, workspace, channel, review, feedback, diff, slug, links, vellum-build
src/core/server/cli.ts         the entry point: `serve`, which the hooks module spawns and reads
src/core/server/preview.ts     the page alone on any directory of documents: a working copy, served, taken away
src/core/protocol.ts           what crosses HTTP, the server's stdout and an extension boundary; JSON
src/core/extension.ts          the contract an extension fills: PageExtension, ServerExtension
                               (EngineExtension lives with the hooks module, core/engine/extension.ts)
src/core/page/                 the Preact page
src/extensions/<id>/           one extension, a file per place it plugs in: page.tsx, server.ts, engine.ts;
                               its own messages in protocol.ts, its boundary in parse.ts
src/extensions/page.ts, server.ts, engine.ts  the three registries, the only way the core reaches an extension
```

Dependencies point toward `src/core/server/domain/`, held by `src/boundaries.spec.ts`. The rules of each
zone load with its files, from `.claude/rules/`: `engine.md`, `server.md`, `page.md`,
`extensions.md`, `tests.md`. The drawings, the assessment and where the next phases land: `docs/architecture.md`.

The tree is drawn here and nowhere else: a rule names the files of its own zone, every other
text points at this section. A fact about Claude Code's engine goes to the relevant page linked from
[Plugin testing](../docs/plugin-testing.md), once, and is pointed at from here. An example is code that compiles
and is tested (`extensions.md` names the ones to copy), never a snippet kept in a doc.

## Commands

```bash
bun install --cwd vellum                                            # once; Claude Code does it at the plugin's cache
bun test vellum                                                     # the server's and the page's `*.spec.ts` suites
bun test vellum/src/core/server/domain/slug.spec.ts                 # one suite; `-t <pattern>` filters by test name
bun run --cwd vellum e2e -- kit.e2e.ts --project=light-1024         # one suite, one window, about 10 s: how a lot is worked on, and how a red test is reproduced
bun run --cwd vellum e2e -- --project=light-1440                    # the whole suite at one window: once, before a push
bun run --cwd vellum e2e                                            # the five windows of `e2e/playwright.config.ts`: CI's, a job per window (`--project=<window>`), on request (the `e2e` label on a PR), not a local one
bun run --cwd vellum e2e:install                                    # Chromium, once per machine and per pinned Playwright
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test vellum       # the hooks module's `*.test.ts` (core/engine, extensions/<id>), through the engine's kit
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate vellum   # what the hooks module hooks and calls
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 command claude --permission-mode default --plugin-dir vellum   # a live session from source
bun vellum/src/core/server/cli.ts serve --session <id> --project <dir> --workdir plans/<date>/wip-<sid8>/   # the server alone, for page work; the trailing slash is required; `--port <n> --token <t> --existing` revives one where it was
bun vellum/src/core/server/preview.ts <dir holding plan.md> [--minutes <n>] [--port <n>]   # the same page on any directory, working or final: it prints the URL and serves a copy it takes away on the way out
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p --setting-sources project --settings '{"disableAllHooks":true}' "/plugin-types vellum/types"    # regenerate types/claude-code.d.ts, as a session on dev does at start; keep claude-code.d.ts only
```

Every command runs from the repository root; lint, types and format are the repository's
gates, listed in its `AGENTS.md`. The server alone prints its `ready` line, port and token, then
a JSON line for each entry of the channel and each change of the review, and serves the page
at `http://127.0.0.1:<port>/t/<token>/`; it exits once its last `POST /api/heartbeat` is past
the grace and no tab holds the event stream (`WATCHDOG` in `http/serve.ts` holds both delays).
Only the hooks module posts the heartbeat, the page does not: alone, an open tab keeps it for
a while, or post the heartbeat in a loop with the header
`x-vellum-token: <token>`. A `POST /api/gate` or `POST /api/open` sent while no tab holds the
event stream calls the opener (`streams.open === 0` in `routes.ts`), so a gate driven by curl
launches `xdg-open` on the human's desktop; `bun test` alone is spared, by `NODE_ENV`.

`preview.ts` takes that heartbeat off your hands: nothing beats it, so `--minutes` is its whole
lifetime, thirty by default, and a tab holds it no longer. It copies the directory into a scratch
`plans/<date>/wip-<sid8>/` rather than linking it, since a listing keeps files alone and a link is
not one, and since the server writes `.review/` and an edited `plan.md` where it serves: an edit
of a source document reaches the next run, never the one in flight.

The copy carries `.review/`, so the page opens where the source left the review: `drafting` on a
directory that has none, `inReview v<last>` on any plan, final or not, with the batches sent on
that version counted, and the page takes comments in both. The source's own `.review/draft.json`
stays behind, its annotations naming the paths of a directory nobody serves here. Run the command
from the repository root: the project is the current directory, and anywhere else the plan's cited
files resolve against the wrong root and `plans/` is made where you stand. Ctrl-C, `SIGTERM`, the
lifetime running out and an approval in the page all take the copy away, under the name the
approval renamed it to; `SIGKILL` leaves it, and `find plans/<date>/ -type f -delete` then
`find plans/<date>/ -depth -type d -empty -delete` finishes the job.

For live hook sessions, read [Hook tests](../docs/plugin-testing/hooks.md).
For engine observations, read its linked runtime reference and `plans/2026-09-15/plan-review-rewrite/`.

## Boundaries

- `types/claude-code.d.ts` is generated, never edited; `vellum/types/**` is ignored by the linters.
- `package.json` + `bun.lock` carry every runtime dependency; a new one goes through the ladder in the repository's `AGENTS.md` first.
- The plugin stands alone: installed, it is a copy of this folder with no repository around it. `tsconfig.json` here names Preact as the JSX runtime, and without it the installed page answers 500. `src/standalone.spec.ts` serves the page from a copy under the temp directory; what the page needs to build lives in this folder, never in a parent.
