# Vellum

A Claude Code plugin: `/vellum:start` enters a mode the hooks module holds, where Claude
writes `plan.md` and calls `mcp__vellum__submit`; the plan and its artifacts open in the
browser, and the reviewer's answer reaches Claude as a prompt. `/vellum:stop` leaves the mode.

## Shape

Four kinds of folder, each with its own job. Only the parts share a form:

- the parts, `src/steps/` and `src/formats/`, a folder each: a step Vellum follows, a format a
  document is read in. Every one is a slice, read the same way: a `contract.ts` that declares it
  (`defineSlice`) and a half per runtime it plugs into (`hooks.ts`, `server.ts`, `page.tsx`); one
  with a part of the workflow adds its pure model, named after the folder, and its `walk.ts`, one
  that parses what it did not produce its `parse.ts`; its helpers and their specs sit beside.
  `formats/image/` is the smallest, a contract and a page half. A part reads the review through
  `review/contract.ts` as types and takes a value of it from its frozen surface; the folder
  takes the glossary's word (`CONTEXT.md`);
- the review, `src/review/`, the frame the parts plug into, which does what no part does: it
  owns the state every part reads (the draft, the Send and its batches, the versions, the
  approval), assembles each part's share of a Send, and hands the formats their composer and
  selection. It keeps a slice's files but is no slice: the runtimes reach it by name, its part
  first in the table, never through a registry. It stays one frame, never a slice per feature
  (gate, Send, approval): those share one state machine and one directory layout, and the first
  review's bugs were exactly cross-feature state;
- the runtimes, `src/runtime/`: the hooks module in Claude Code, the server, the page. Each owns
  a process and its IO, runs the review by name and the parts through its registry alone, and
  turns each part's half into its own representation of it (`*Extension`);
- a pure machine, `src/workshop/`: the workflow judged against a table of rows (`next`), the
  view a reader takes of it, and the machinery the review and the parts are built with; it
  names no event of anybody's and imports nothing outside itself.

```
hooks/hooks.json            Claude Code's folder: it names the hooks module, nothing else lives there
skills/start, skills/stop   the way in and the way out
src/workshop/               pure, no IO: the workflow (`next`, the table), view, rows, waits, plugs
                            (`defineSlice`), paths, workspace, channel, slug, links, vellum-build
src/review/                 the frame: contract.ts its events, rows and types; surface.ts and composer.tsx
                            what a part may use of it; review, feedback, diff its domain; events.ts its
                            model; server.ts, routes.ts, draft.ts, parse.ts its server half; hooks.ts its
                            tool and turn-end gate; comments, composer, decision-bar, editor, anchoring,
                            selection, caret its page
src/runtime/hooks/          the hooks module: register.ts spells `$`, the rest takes a `Host`; client.ts the server's
        │ HTTP, token header, down; the server's stdout, up
src/runtime/server/         the server: cli.ts `serve`, preview.ts the page alone on any directory, queue.ts the
                            queue and the step, effects.ts, http/ routes and serve, every IO, slice.ts
src/runtime/page/           the Preact page
src/runtime/protocol.ts     what crosses HTTP, the server's stdout and a part's boundary; JSON
src/runtime/extension.ts    what a part's page and server halves fill (a hooks half: runtime/hooks/extension.ts), and
                            the runtimes' own representation of a part, which the registries make from them
src/runtime/*/slices.ts     each runtime's registry, the only way it reaches a part
src/steps/<name>/           a step Vellum follows: grill/, agent-review/, proposal/
src/formats/<name>/         a format a document is read in: markdown/, html/, image/
src/proof.ts                the proof of the table, the tests' alone: each part's walk.ts, alone, then in pairs
scripts/contract-diff.ts    what a reviewer reads of a range before its code, as Markdown for the PR
```

Dependencies point toward `src/workshop/`, which imports nothing outside itself, not even a
type. The review imports the workshop and the runtimes, never a part. A part imports the
workshop, what a runtime's folder offers the halves it fills, the review's contract and another
slice's `contract.ts` as types, and the review's surface; a runtime reaches a part through its
`slices.ts` alone, as `src/boundaries.spec.ts` holds. The rules of each zone load with its
files, from `.claude/rules/`: `workshop.md`, `engine.md`, `server.md`, `page.md`,
`extensions.md`, `slices.md`, `tests.md`.

The tree is drawn here and nowhere else: a rule names the files of its own zone, every other
text points at this section. A fact about Claude Code's engine goes to the relevant page linked from
[Plugin testing](../docs/plugin-testing.md), once, and is pointed at from here. An example is code that compiles
and is tested (`extensions.md` names the ones to copy), never a snippet kept in a doc.

## Commands

```bash
bun install --cwd vellum                                            # once; Claude Code does it at the plugin's cache
bun test vellum                                                     # the server's and the page's `*.spec.ts` suites
bun test vellum/src/workshop/slug.spec.ts                           # one suite; `-t <pattern>` filters by test name
bun run --cwd vellum e2e -- kit.e2e.ts --project=light-1024         # one suite, one window, about 10 s: how a lot is worked on, and how a red test is reproduced
bun run --cwd vellum e2e -- --project=light-1440                    # the whole suite at one window: once, before a push
bun run --cwd vellum e2e                                            # the five windows of `e2e/playwright.config.ts`: CI's, a job per window (`--project=<window>`), on request (the `e2e` label on a PR), not a local one
bun run --cwd vellum e2e:install                                    # Chromium, once per machine and per pinned Playwright
bun run --cwd vellum contract-diff <base>..<head>                   # for a PR: the contracts' diffs, what Claude reads, the rules changed, the test titles, the bodies changed, the boundary and walk suites at <head>
claude plugin test vellum       # the hooks module's `*.test.ts` (runtime/hooks, review, steps/<name>), through the engine's kit
claude plugin validate vellum   # what the hooks module hooks and calls
command claude --permission-mode default --plugin-dir vellum   # a live session from source
bun vellum/src/runtime/server/cli.ts serve --session <id> --project <dir> --workdir plans/<date>/wip-<sid8>/   # the server alone, for page work; the trailing slash is required; `--port <n> --token <t> --existing` revives one where it was
bun vellum/src/runtime/server/preview.ts <dir holding plan.md> [--minutes <n>] [--port <n>]   # the same page on any directory, working or final: it prints the URL and serves a copy it takes away on the way out
bun .claude/hooks/regenerate-plugin-types.ts <<< '{}'               # what a session does at start: on a checkout on dev whose types/ another Claude Code wrote, regenerate them from the installed one; elsewhere, report the drift
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
opens a tab on the human's desktop (`openerOf` in `browser.ts`); `bun test` alone is spared, by `NODE_ENV`.

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

- `types/claude-code.d.ts` and `types/claude-code-tools.d.ts` are Claude Code's own, copied from the `.claude-plugin/types/` it writes, never edited; `vellum/types/**` is ignored by the linters.
- `package.json` + `bun.lock` carry every runtime dependency; a new one goes through the ladder in the repository's `AGENTS.md` first.
- The plugin stands alone: installed, it is a copy of this folder with no repository around it. `tsconfig.json` here names Preact as the JSX runtime, and without it the installed page answers 500. `src/standalone.spec.ts` serves the page from a copy under the temp directory; what the page needs to build lives in this folder, never in a parent.
