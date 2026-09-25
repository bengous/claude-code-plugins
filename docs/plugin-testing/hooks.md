# Plugin hook tests

[Plugin testing index](../plugin-testing.md). Read for command-hook payloads, function-hook validation and the engine test kit.

## Testing a plugin hook from source

A `hooks/hooks.json` under the plugin loads with `--plugin-dir` like the
skills do: the debug log says `Read hooks.json for plugin <name>` and
`Loading hooks from plugin: <name>`.

- Pipe a payload first. A command hook is a script on stdin, so
  `printf '{"session_id":"t","cwd":"/x","tool_input":{...}}' | HOME=<tmp> bun
  <plugin>/scripts/<hook>.ts` runs it in seconds with no session, and the
  temp home holds what it wrote. The field names are the event's: see
  https://code.claude.com/docs/en/hooks for each event's input.
- `--debug-file <path>` keeps the log; `--debug` alone prints nothing in `-p`.
  The log names a hook only when it printed something: `Hook <name> (<event>)
  success:` followed by the output. A hook that exits 0 in silence leaves one
  unnamed `Hook output does not start with {` line, so its proof is its
  effect: the file it wrote, the comment it posted.
- `ExitPlanMode` is not callable in `-p`, `--permission-mode plan` included:
  the model writes the plan file and reports that it cannot call the tool. A
  `PreToolUse` hook on it runs only in an interactive session.
- A `PostToolUse` hook on `Bash` runs in `-p`. A hook that reads a session id
  from its own transcript is fed one by putting the marker it scans for in the
  prompt; the session's own id is `session_id` in the final JSON.
- A hook that publishes (a PR comment) has no dry run; its live test is the
  PR it lands on, opened from a `--plugin-dir` session.

## Testing a hooks module (function hooks)

A plugin whose `hooks/hooks.json` names `modules` is a hooks module: a
TypeScript entry point exporting `register(on, options)`, run by the engine in
an environment of its own. It may import, by value, any file inside the plugin,
under the [loader rules](hook-runtime.md#module-loader).

- A plugin with `package.json` + `bun.lock` gets `bun install
  --frozen-lockfile --ignore-scripts` at its cache when installed. Under
  `--plugin-dir` nothing installs: run `bun install --cwd <plugin>` yourself,
  as `scripts/run-gates.ts` does for `vellum`.

- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate <plugin>` reads
  the module's source and prints what it hooks (`skill.prompt{skill=...}`)
  and every `$` call with the function that makes it. It needs no login and
  runs in the repo's gates. Run it first: a hook the engine does not list is a
  hook that will not fire.

- `/plugin-types <plugin>/types` writes the contract of the running build;
  regenerate it after each Claude Code update. It runs headless too:
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p --setting-sources project "/plugin-types <plugin>/types"`;
  without the variable the command does not exist, and the prompt goes to
  the model. Keep
  `claude-code.d.ts` only; the `-mcp` and `-plugins` files describe the
  developer's own session.

- Launch with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` until function hooks ship
  publicly. Without it the module never loads and the plugin's skills run as
  if it were not there; with it the debug log says
  `hooks module <name> loaded (worker, environment 1, tier user); events: ...`.

- To read that line headless, give `--debug-file <path>` and the prompt on
  stdin: `--debug` alone prints nothing under `-p`, and `--plugin-dir` takes
  the positional prompt, so `claude -p --plugin-dir <plugin> "say ok"` fails
  with `Input must be provided either through stdin or as a prompt argument`.

- `claude plugin test <dir>` runs `*.test.ts` files that import
  `claude-code/testing` in the engine's environment. It takes no argument but
  the directory, and two rules follow from that: it loads the module from
  `<dir>/hooks/hooks.json` only, refusing a `modules` entry that climbs out
  of the plugin (`path-traversal`; `vellum` names
  `../src/core/engine/register.ts`, inside it), and it collects every
  `*.test.ts` below `<dir>`. So the kit runs from the plugin root, and a
  `bun:test` suite elsewhere in the plugin fails that run unless it is named
  otherwise: `vellum` names its server and page suites `*.spec.ts`, and keeps
  `*.test.ts` for the kit's own, beside the module in
  `vellum/src/core/engine/`. `bun test` would pick those up and fail on the
  import, so the repo's `bunfig.toml` ignores `vellum/**/*.test.ts`.

- The kit's `$` has no `classic` noun, so a `classic.PermissionRequest` hook
  cannot be raised from a test.

- The kit starts no subagent. Nothing answers beneath `agent.spawn`, and a
  fixture hook that answers `{ model, agentId }` without `next` reaches the
  module with no `agentId`, as the contract says of a hook that started none.
  The event a fixture sees carries the Agent tool's input (`subagent_type`,
  `run_in_background`), not the typed `subagentType`. `on("agent.list")`
  answers `$.agent.list()`. A test's own hook cannot call `$.agent.*` at all:
  the kit refuses a call the module's scan does not list. A launch that
  succeeds is checked in a live session.

- A test's `on("tool.call", { tool: "TaskStop" }, ...)` answers the module's
  own `$.tool.call({ tool: "TaskStop", ... })`: the kit hands the call to the
  test's hooks, and what they return (a result, `isError`, a `deny`) is what the
  module reads.

Read [hook runtime behavior](hook-runtime.md) when a module fails to load, reloads, denies a tool or coordinates a server.
