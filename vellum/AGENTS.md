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
        │ HTTP, token header
src/core/server/adapters/      http/routes.ts, http/serve.ts, fs.ts, browser.ts: every IO
src/core/server/app/review.ts  the use case: read, decide, apply
src/core/server/domain/        pure, no IO: paths, workspace, review, feedback, diff, slug, links
src/core/server/cli.ts         the entry point: `start` spawns `serve` detached
src/core/protocol.ts           what crosses HTTP and an extension boundary; JSON
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
text points at this section. A fact about Claude Code's engine goes to `docs/plugin-testing.md`
at the repository root, once, and is pointed at from here. An example is code that compiles
and is tested (`extensions.md` names the ones to copy), never a snippet kept in a doc.

## Commands

```bash
bun install --cwd vellum                                            # once; Claude Code does it at the plugin's cache
bun test vellum                                                     # the server's and the page's `*.spec.ts` suites
bun test vellum/src/core/server/domain/slug.spec.ts                 # one suite; `-t <pattern>` filters by test name
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test vellum       # the hooks module's `*.test.ts` (core/engine, extensions/<id>), through the engine's kit
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate vellum   # what the hooks module hooks and calls
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 command claude --permission-mode default --plugin-dir vellum   # a live session from source
bun vellum/src/core/server/cli.ts serve --session <id> --project <dir> --workdir plans/<date>/wip-<sid8>/   # the server alone, for page work; the trailing slash is required; `--port <n> --token <t> --existing` revives one where it was
claude -p --setting-sources project "/plugin-types vellum/types"    # regenerate types/claude-code.d.ts after a Claude Code update; keep claude-code.d.ts only
```

Every command runs from the repository root; lint, types and format are the repository's
gates, listed in its `AGENTS.md`. The server alone prints port and token and serves the page
at `http://127.0.0.1:<port>/t/<token>/`; it exits once its last `POST /api/heartbeat` is
90 s old and no tab holds the event stream. Only the hooks module posts the heartbeat, the
page does not: alone, an open tab keeps it for 15 minutes, or post the heartbeat in a loop with the header
`x-vellum-token: <token>`.

A live session, the browser, and the facts measured on Claude Code: `docs/plugin-testing.md`
at the repository root, § Testing a hooks module, and `plans/2026-09-15/plan-review-rewrite/`.

## Boundaries

- `types/claude-code.d.ts` is generated, never edited; `vellum/types/**` is ignored by the linters.
- `package.json` + `bun.lock` carry every runtime dependency; a new one goes through the ladder in the repository's `AGENTS.md` first.
