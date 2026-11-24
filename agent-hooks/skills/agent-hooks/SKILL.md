---
name: agent-hooks
description: Set up or check the agent-hooks kit in a repository (fixers before each write and Stop lanes on the files a session changed, wired by this plugin). Use when the user asks to add quality hooks to a repo, to write or check `.claude/agent-hooks.jsonc`, to run the hooks doctor or verify, to measure what the hooks inject into the context (noise), when a Stop hook misbehaves (blocks on the wrong files, never blocks, a fixer seems to do nothing), or when a desktop session's worktree lacks the main checkout's `node_modules` or another dependency directory.
argument-hint: "[doctor|verify|noise]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts *)
---

# agent-hooks

The plugin's `hooks/hooks.json` wires SessionStart, PreToolUse `Edit|Write`, Stop and SubagentStop to
`${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts`. A git checkout opts in with one file at its top,
`.claude/agent-hooks.jsonc`; anywhere else every hook exits at once, silently. One config per checkout:
a config in a subdirectory or outside git is never read. Never declare the kit's hooks in a settings
file as well: they would run twice.

## Set-up

1. Read what the repository already runs (package scripts, formatter and linter configs, CI) and draft
   the config with the user: fixers for what may rewrite a file, lanes for what checks.
2. Write `.claude/agent-hooks.jsonc` once the user agrees; the kit never writes it.
3. Run `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts doctor` from the repository and fix every `MISSING` and
   `FAIL` line before the first turn; a `WARN` line (a wiring to correct, a fixer the probes had no
   time to try, a linter that leaves a finding in a tracked file) never fails it.
4. When sessions run in worktrees, declare the directories a worktree shares with the main checkout,
   such as `node_modules`, in Claude Code's own setting
   `worktree.symlinkDirectories` (paths relative to the repository's top) in the main checkout's
   `.claude/settings.json` or `.claude/settings.local.json`; `~/.claude/settings.json` is not read for
   it. The kit links them only in a worktree that holds `.claude/agent-hooks.jsonc`, so commit that
   file. Ignore each in the repository's `.gitignore` with a pattern without a trailing slash
   (`node_modules`, not `node_modules/`): to git a link is a file. Declare only a directory a session
   reads and runs from, never one the repository's own scripts install or build into in each checkout:
   a write into it (an install, a build) lands in the main checkout, and a
   relative link inside it (a workspace package in `node_modules`) resolves to the main checkout's
   files, not the worktree's.

## Config

```jsonc
{
  "exclude": ["**/node_modules/**"],   // generated or vendored: no fixer touches them, no `files` lane is handed them
  "cap": 3,                             // blocks in a row, within one turn, before the Stop lets it end
  "fixers": {
    "oxlint": { "on": "**/*.{ts,tsx}", "file": "oxlint --fix --quiet {file}", "loop": true },
    "prettier": { "on": "**/*.{ts,md}", "exclude": ["plans/**"], "stdin": "prettier --stdin-filepath {path}", "at": "both" }
  },
  "lanes": {
    "lint": { "on": "**/*.ts", "takes": "files", "run": "oxlint --format=unix {files}", "timeout": 60 },
    "clippy": { "on": "**/*.rs", "takes": "project", "cwd": "pkg", "run": "cargo clippy", "verdict": "note" }
  }
}
```

- A fixer has `on` (a glob on the checkout-relative path), exactly one of `file` (rewrites the file it is
  given) and `stdin` (reads the content, prints the fixed one), and optional `exclude`, `loop` and `at`:
  `edit` (default, before each write), `stop` (on the session's files at the Stop) or `both`. Fixers run
  in declaration order, the `loop` ones first until the content settles (5 passes at most), then the
  others once. Placeholders: `{file}` (the path the fixer must rewrite, a scratch copy at an edit),
  `{path}` (the real checkout-relative path), `{root}`, `{pkg}`. A `file` command must hold `{file}`
  and no `{path}`, a `stdin` command no `{file}`: a fixer never touches the real file at an edit.
- A lane has `on`, `takes` (`files`: the changed files it matches, on disk; `project`: runs once when any
  matches, deletions included), `run`, and optional `exclude`, `cwd` (`root`, or `pkg`: once per package,
  from it), `verdict` (`block` default, or `note`: reported, never blocks) and `timeout` in seconds
  (default 60). Placeholders: `{files}`, `{root}`, `{pkg}`.
- `pkg` is the nearest directory above the file holding a `package.json` or a `Cargo.toml`, else the
  top of the checkout. A program resolves from `<pkg>/node_modules/.bin`, then the top's, then `PATH`;
  one named with a `/` resolves against the top. A fixer always runs from the top, a lane from the top
  unless its `cwd` is `pkg`. No shell runs: quotes group words, nothing expands.
- An unknown key, an unknown placeholder or a wrong type fails with the file and the key path: at an
  edit as a note to the user, at the Stop as a block.

## What each hook does

- SessionStart: in a linked worktree, first links each directory the main checkout's
  `.claude/settings.json` and `.claude/settings.local.json` declare in `worktree.symlinkDirectories`, which
  Claude Code applies at `--worktree` and `EnterWorktree` but the desktop app's Code tab does not apply
  to the worktree it creates. A declared directory the main checkout holds becomes a link to it at the
  same path in the worktree, unless the worktree already holds that path or lacks its parent directory.
  One git would not ignore as a link (a pattern with a trailing slash ignores only a directory) is not
  linked, and a note tells the user which pattern to write. A settings file that is not valid JSONC,
  a `worktree` that is not an object, a `worktree.symlinkDirectories` that is not an array of paths, or a declared path outside the
  repository stops the linking and is a note too; an absent settings file declares nothing. A session in the main
  checkout links nothing. Then it photographs the checkout around the cwd (its dirty tree), once per
  session, and removes the scratch directories a killed pre-edit left.
- PreToolUse: photographs the edited file's checkout at the agent's first edit there, then runs the
  `edit` fixers on a copy of the new content in `.agent-hooks-XXXXXX/` beside the file, so a tool finds
  its config and ignore files as for the real file, and hands Claude Code the result as `updatedInput`
  (`agent-hooks: fixed and formatted <path> before writing`). A fixer that fails or is missing says
  nothing, and the others still run: a `stdin` fixer's output counts only on exit 0, a `file` fixer's
  rewrite counts whatever its exit, since a linter that fixed what it could exits non-zero on the rest.
  An Edit the fix would undo is left alone.
- Stop and SubagentStop: in each checkout the agent photographed, and for the main session the one
  around its cwd, the changed files are those that differ from the photo, or the whole dirty tree
  without one. The `stop` fixers run on them, then the lanes. It blocks while the agent makes progress
  on its failing set (a changed set, or fewer diagnostic lines), at most `cap` times in a row within a
  turn; then it lets the turn end with a note. A set left red is remembered across turns: the next
  turn's Stop only notes it until the set changes, which is the first thing to check when a Stop
  "never blocks". A lane green for the same HEAD and dirty tree is not run again. It
  says nothing in plan mode, or while the main session waits on a subagent, workflow or teammate. A
  subagent keeps its own state, `<session>.<agent_id>`, and is measured only where its own edits
  photographed. A git call or lane that runs out of the hook's time is reported as a failure. A Stop
  whose state cannot be saved never blocks: it tells the user, report included.
- State: `$XDG_STATE_HOME/agent-hooks/`, `~/.local/state/agent-hooks/` without that variable, or the
  directory `AGENT_HOOKS_STATE_DIR` names; one file per agent and checkout, pruned after 7 days.

## Commands

- `doctor [--config <file>]`: the checkout, the config's validity (`--config` checks a file from
  elsewhere against the cwd's checkout), each fixer's and lane's program or `MISSING`, each fixer tried
  on a copy of one tracked file per extension it selects, the Claude Code wiring, a photo's timing and
  the last Stop. `FAIL fixer <name> fails on <path>: <first line> (exit <n>)` is a fixer the hooks keep
  silent on: a formatter handed a file its own ignore file excludes, a missing parser. A `loop` fixer
  that exits non-zero is a `WARN`: a linter exits so on a finding it leaves in the file. `MISSING` also
  names a `bun run <script>` whose package has no such script. Exit 1 on a config that does not read
  and on any `MISSING` or `FAIL`.
- `verify [--all] [files...]`: the Stop fixers and lanes now, without the green cache or the deadline,
  on the files the last main session changed; `--all` takes the whole dirty tree, named files run as
  named. Its fixers rewrite the real files, as at a Stop. Exit 1 when a blocking lane fails.
- `noise [--days N]`: from the Claude Code transcripts of the last N days (default 7) whose cwd lies in an
  opted-in checkout, the count and characters of what the kit's hooks put in front of the agent
  (`additionalContext`, block reasons) and the user (`systemMessage`), the Stops by outcome, and each
  lane's share of the reports. Aggregates only.

## Ceilings

- The photo bounds what is measured, not who wrote it: concurrent agents in one checkout see each
  other's changes since their own photo.
- A subagent that writes through Bash alone has no photo, so its SubagentStop checks nothing.
- A session without a photo of its cwd's checkout is measured over the whole dirty tree there, and
  blocks at most once per failing set: it cannot tell its work from what it found.
- `.claude/worktrees/` and nested repositories are out of the scope: each is a checkout of its own.
- A write through a linked directory lands in the main checkout: an install run in a worktree changes
  the main checkout's dependencies.
- A state written by another version of the kit reads as absent: the session loses its photo and is
  measured over the whole dirty tree.
