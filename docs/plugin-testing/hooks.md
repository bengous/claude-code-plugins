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

- `claude plugin validate <plugin>` reads
  the module's source and prints what it hooks (`skill.prompt{skill=...}`)
  and every `$` call with the function that makes it. It needs no login and
  runs in the repo's gates. Run it first: a hook the engine does not list is a
  hook that will not fire.

- Claude Code writes the contract of the running build into
  `<plugin>/.claude-plugin/types/` each time it loads the plugin with
  `--plugin-dir`, git-ignored (official docs: `plugins/mods/create` § Get
  type definitions for your version). A `claude -p --plugin-dir` run given no
  prompt writes it too, then stops on the missing prompt before any model
  call. `claude-code-tools` follows the account's features and environment
  variables such as `CLAUDE_CODE_FORK_SUBAGENT`, so
  `bun ./scripts/claude-code-types.ts regenerate` runs it with an empty
  `CLAUDE_CONFIG_DIR` and only `PATH` and `HOME`, and copies `claude-code`
  and `claude-code-tools` back; `claude-code-mcp` describes the developer's
  own servers.

- vellum's copy, `vellum/types/`, follows the installed build through a pull
  request, never in a developer's checkout. At session start
  `.claude/hooks/claude-code-types.ts` starts
  `bun ./scripts/claude-code-types.ts run` detached for an installed version
  no run settled yet, unless a run is going. The run decides after its fetch:
  nothing to do when `origin/dev`, or the rolling branch
  `chore/claude-code-types` while its pull request is open, carries the
  installed types or newer. Otherwise it probes the signing key without a
  passphrase prompt, then, in `<main worktree>.wt/claude-code-types`, it
  rebases the live branch onto `origin/dev` or starts it again from there,
  installs the dependencies, regenerates and commits the types, and hands the
  worktree to a headless Claude (`scripts/claude-code-types.prompt.md`) that
  judges the update's impact on each hooks module and commits what it calls
  for; the run then pushes the branch and opens or updates its pull request,
  which the human lands. A version settles once the run publishes, finds
  nothing to do, is stopped (`kill <pid>`, which stops its agent with it), or
  fails from the agent on; such an end names the log, the kept worktree and
  the command that reruns it, and the run refuses to recreate a worktree that
  holds work. An earlier failure removes its worktree and is retried at the
  next session start. The hook's one output is a
  `systemMessage`, outside the model's context: the run's start, then its
  outcome at the next session start, read with the run's lock, log and
  settled version from `<git common dir>/claude-code-types/`.

- Mods load by default. Where they are off (`--bare`, `--safe-mode`,
  `disableAllHooks`, an organization's policy) the module never loads and
  the plugin's skills run as if it were not there; loaded, the debug log says
  `hooks module <name> loaded (worker, environment 1, tier user); events: ...`.

- To read that line headless, give `--debug-file <path>`: `--debug` alone
  prints nothing under `-p`. A positional prompt after `--plugin-dir <plugin>`
  stays the prompt; with none, the run stops on `Input must be provided
  either through stdin or as a prompt argument` once the plugin has loaded.

- `claude plugin test <dir>` runs `*.test.ts` files that import
  `claude-code/testing` in the engine's environment. It takes no argument but
  the directory, and two rules follow from that: it loads the module from
  `<dir>/hooks/hooks.json` only, refusing a `modules` entry that climbs out
  of the plugin (`path-traversal`; `vellum` names
  `../src/runtime/hooks/register.ts`, inside it), and it collects every
  `*.test.ts` below `<dir>`. So the kit runs from the plugin root, and a
  `bun:test` suite elsewhere in the plugin fails that run unless it is named
  otherwise: `vellum` names its server and page suites `*.spec.ts`, and keeps
  `*.test.ts` for the kit's own, beside the module in
  `vellum/src/runtime/hooks/`. `bun test` would pick those up and fail on the
  import, so the repo's `bunfig.toml` ignores `vellum/**/*.test.ts`, as it
  ignores `todos/**/*.test.ts` and the retired plugins of `archive/**`.

- The kit's `$` has no `classic` noun, so a `classic.PermissionRequest` hook
  cannot be raised from a test.

- The kit keeps no conversation: a prompt submitted raises no
  `session.append`. A test raises one with its own `$.session.append`, the
  row's `door`, `origin` and `agentId` as it writes them, and the kit keeps
  the row beneath every hook, looking for no loop, so a row that names a
  subagent passes too (`vellum/src/steps/grill/hooks.test.ts`); `mock.session`
  reads the kept rows back. A module's own `$.session.append` is kept with
  `door: "note"`, the plugin as `origin` and a fresh `uuid`. The rows the
  engine keeps around a turn are checked in a live session.

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
