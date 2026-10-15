---
name: agent-hooks
description: Set up or check the agent-hooks kit in a repository (the session-scoped fixers and Stop lanes wired once per machine). Use when the user asks to add hooks to a repo, to init agent hooks, to run the hooks doctor, or when a Stop hook misbehaves (blocks on the wrong files, never blocks, names a missing tool).
argument-hint: "[init|doctor]"
---

# agent-hooks

The kit is this plugin, run as `bun ${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts`. Its `hooks/hooks.json` wires
Claude Code once per machine, wherever the plugin is enabled; Codex calls the same entry with
`--harness codex` from its own hook config. A repository opts in
with one file, `.claude/agent-hooks.jsonc`; without it the kit does nothing. Never copy kit code into a
repository and never redeclare its hooks in a repo `.claude/settings.json` or `.codex/config.toml`: a
hook declared at both levels runs twice.

## init

1. From the repo root, run `bun ${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts init --print` and show the JSONC it prints. It picks the presets
   from what the tree holds: `ts` for a `package.json`, `rust` for a `Cargo.toml`, `shell` for `*.sh`;
   it disables the `typecheck` and `test` lanes when the root
   `package.json` has no such script.
2. Read the presets it names under `${CLAUDE_PLUGIN_ROOT}/presets/` and say in two lines what
   runs before each write (fixers) and at Stop (lanes). Adjust with the user: a lane to disable
   (`"<lane>": { "disabled": true }`), a timeout, a `verdict: "note"` for a lane that must inform without
   blocking, `pre-edit.exclude` globs for generated or vendored trees.
3. Ask for the user's agreement, then write `.claude/agent-hooks.jsonc` (the kit never writes it).
4. Run `bun ${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts doctor` and fix every `MISSING` line (a tool absent from `node_modules/.bin` and
   PATH, a `bun run <script>` with no such script) before the first turn.
5. Summarize: the file written, the lanes that will block, the ones that only note.

## doctor

Run `bun ${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts doctor` from the repo root (or `--config <file>` to check another config in this
root). It prints the merged config, one line per fixer and lane with the resolved binary or `MISSING`,
the global wiring (`WARN` when a harness lacks the Stop hook), the photo timing, the last Stop of the
root and a full `verify`. Explain each `MISSING` and `WARN` to the user and propose the fix: install
the tool, add the script, or disable the lane. Exit 1 means at least one `MISSING` or a failing lane.

## Reading a Stop

- The Stop blocks only while the agent makes progress on the failing set (at most `stop.cap` times in
  a row, default 3); otherwise it lets the turn end with a `systemMessage` that starts with
  `agent-hooks:`. Nothing to fix in the kit when that message shows: the agent stopped progressing.
- `bun ${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts verify [--all] [files...]` runs the lanes now, without the green cache, and prints one
  line per lane. `--all` takes the whole dirty tree instead of the session scope.
- State: `~/.local/state/agent-hooks/<session>__<root hash>.json` (`lastRun.lanes`, green keys, loop
  counters), pruned after 7 days.
