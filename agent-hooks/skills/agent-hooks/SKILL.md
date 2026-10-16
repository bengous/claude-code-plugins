---
name: agent-hooks
description: Set up or check the agent-hooks kit in a repository (the session-scoped fixers and Stop lanes this plugin wires). Use when the user asks to add hooks to a repo, to init agent hooks, to run the hooks doctor, or when a Stop hook misbehaves (blocks on the wrong files, never blocks, names a missing tool).
argument-hint: "[init|doctor]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts *), Read(~/.claude/plugins/cache/*/agent-hooks/*/presets/**)
---

# agent-hooks

The kit is this plugin, run as `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts`. Its `hooks/hooks.json` wires
Claude Code wherever the plugin is enabled. Codex has no plugin: its own hook config calls the same
entry with `--harness codex`, through `~/.local/bin/agent-hooks`, a symlink to the entry in a checkout
that does not move with the plugin's version. A repository opts in with one file,
`.claude/agent-hooks.jsonc`; without it the kit does nothing. Never copy kit code into a repository and
never redeclare its hooks in a `.claude/settings.json` or `.codex/config.toml`: a hook declared at two
levels runs twice.

## init

1. From the repo root, run `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts init --print` and show the JSONC it
   prints. It picks the presets from what the tree holds: `ts` for a `package.json`, `rust` for a
   `Cargo.toml`, `shell` for `*.sh`; it disables the `typecheck` and `test` lanes when the root
   `package.json` has no such script.
2. Read the presets it names under `${CLAUDE_PLUGIN_ROOT}/presets/` and say in two lines what
   runs before each write (fixers) and at Stop (lanes). Adjust with the user: a lane to disable
   (`"<lane>": { "disabled": true }`), a timeout, a `verdict: "note"` for a lane that must inform without
   blocking, `pre-edit.exclude` globs for generated or vendored trees (never fixed, never handed to a
   `files` lane; a `project` lane still runs when they change).
3. Ask for the user's agreement, then write `.claude/agent-hooks.jsonc` (the kit never writes it).
4. Run `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts doctor` and fix every `MISSING` line (a tool absent from
   `node_modules/.bin` and PATH, a `bun run <script>` with no such script) before the first turn.
5. Summarize: the file written, the lanes that will block, the ones that only note.

## doctor

Run `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts doctor` from the repo root (or `--config <file>` to check
another config in this root). It prints the merged config, one line per fixer and lane with the resolved
binary or `MISSING`, the wiring of each harness, the photo timing, the last Stop of the root and a full
`verify`. Explain each `MISSING` and `WARN` to the user and propose the fix: install the tool, add the
script, or disable the lane. For the wiring:

- `WARN claude wiring: no agent-hooks Stop hook`: the plugin is not enabled; enable it, never add the
  hooks to a settings file.
- `WARN claude wiring: plugin ... and a hook in ...`: both run the kit; remove the hook from that
  settings file.
- `WARN codex wiring`: the Codex config calls no `agent-hooks stop --harness codex`; only a user who
  runs Codex needs it.

Exit 1 means at least one `MISSING` or a failing lane.

## Reading a Stop

- The Stop blocks only while the agent makes progress on the failing set (at most `stop.cap` times in
  a row, default 3); otherwise it lets the turn end with a `systemMessage` that starts with
  `agent-hooks:`. Nothing to fix in the kit when that message shows: the agent stopped progressing.
- `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts verify [--all] [files...]` runs the lanes now, without the green
  cache, and prints one line per lane. `--all` takes the whole dirty tree instead of the session scope.
- The kit gates the main session's Stop only: it is not wired on SubagentStop, and a subagent's Stop
  is not checked.
- State: `~/.local/state/agent-hooks/<session>__<root hash>.json` (`lastRun.lanes`, green keys, loop
  counters), pruned after 7 days.
