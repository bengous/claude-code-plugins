---
name: agent-hooks
description: Set up or check the agent-hooks kit in a repository (the session-scoped fixers and Stop lanes this plugin wires, and its landing guard on Bash). Use when the user asks to add hooks to a repo, to init agent hooks, to run the hooks doctor, to declare how a repository lands, when a Stop hook misbehaves (blocks on the wrong files, never blocks, names a missing tool), or when the landing guard refuses a push, a merge or a release.
argument-hint: "[init|doctor]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts *), Read(~/.claude/plugins/cache/*/agent-hooks/*/presets/**)
---

# agent-hooks

The kit is this plugin, run as `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts`. Its `hooks/hooks.json` wires
Claude Code wherever the plugin is enabled. Codex has no plugin: its own hook config calls the same
entry with `--harness codex`, through `~/.local/bin/agent-hooks`, a symlink to the entry in a checkout
that does not move with the plugin's version. A repository opts in with one file,
`.claude/agent-hooks.jsonc`; without it the kit runs only its landing guard. Never copy kit code into a repository and
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
- `WARN claude wiring: ... wires the Stop but no SubagentStop`: the kit runs from a settings file that
  gates the main session only; enable the plugin, which wires both, and remove those hooks.
- `WARN codex wiring`: the Codex config calls no `agent-hooks stop --harness codex`; only a user who
  runs Codex needs it.
- `MISSING checkout: ... is outside git`: the root lies in no git work tree, so the kit photographs
  nothing and the Stop checks nothing there, silently; the doctor is the one place that says so.

Exit 1 means at least one `MISSING` or a failing lane.

## Reading a Stop

The Stop measures checkouts (git work trees); roots only check. Each fact has one owner:

- Photo: one per agent and checkout, the dirty tree when the agent first reached it. Taken at
  SessionStart for the checkout around the cwd, when a root encloses the cwd; at the first Edit or
  Write (Claude) or the first `apply_patch` (Codex, whose hook runs after the write, so the patched
  files count as changed; a patch spanning several checkouts photographs each) for any other
  checkout. `resume` and `compact` keep it. Paths are read with their symlinks resolved, as git names
  them.
- Changed files: in each photographed checkout, the dirty files whose content differs from the photo.
  For the main session only, the checkout around its cwd counts without a photo, over its whole dirty
  tree (Bash and a Codex patch photograph nothing); the Stop says so in a note. A checkout left without
  a photo is measured only while the cwd stands in it.
- Owner: each changed file goes to its nearest root holding `.claude/agent-hooks.jsonc`, the rule
  pre-edit uses, computed once over every changed file. The roots owning at least one file run their
  fixers and lanes on their own files, each under its own config; a nested root's file never reaches
  the outer root's lanes. A report names its root unless that root is the one around the cwd.
- Brake: one per agent and checkout. It blocks while the agent makes progress on the checkout's
  failing set (a changed set, or fewer diagnostic lines on the same set), at most `stop.cap` times in a
  row (default 3; the smallest cap of the failing roots); otherwise it lets the turn end with a
  `systemMessage` that starts with `agent-hooks:`. A checkout without a photo blocks once per failing
  set. Nothing to fix in the kit when that message shows: the agent stopped progressing.
- Verdict: the Stop blocks if any brake blocks.
- `${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts verify [--all] [files...]` runs the lanes now, without the green
  cache, and prints one line per lane, on the files this root owns among those the last main session
  changed in the checkout. `--all` takes the whole dirty tree instead; named files run as named.
- A subagent's SubagentStop is measured the same way on its own states: the checkouts its own Edits or
  Writes photographed, under its own brake. Its cwd's checkout is not added, so a subagent that edited
  nothing is let through. The main session's Stop waits while a subagent, workflow or teammate still
  runs.
- State: `~/.local/state/agent-hooks/<agent>__<checkout hash>.json`, `<agent>` the session id or
  `<session>.<agent id>` for a subagent: the photo, the brake, and per root its green keys and
  `lastRun.lanes`; pruned after 7 days.
- Pre-edit fixes a copy of the new content in `.agent-hooks-XXXXXX/` beside the file, so the fixers find
  the config and the overrides of the real path. The kit's own scope never counts that copy, but another
  tool watching the tree can see it while the fixers run, and a pre-edit killed past its deadline leaves
  it until the next SessionStart, which removes the untracked directories of that exact name, holding no
  tracked file, older than the pre-edit deadline. A path that merely starts with `.agent-hooks-` is the
  repository's own.

## Ceilings

What the model bounds and the kit does not try to cross:

- The photo bounds what is measured, not who wrote it. Concurrent agents in one checkout see each
  other's changes since their own photo: a subagent can block on a sibling's file, and its Stop fixers
  rewrite it.
- With no root around the cwd, SessionStart photographs nothing, as without a config, and a nested
  root gets its photo at the first Edit, Write or `apply_patch` under it. Bash-only writes under a
  nested root, with no root around the cwd, go unchecked.
- A state file of another version reads as absent, and the kit carries no compatibility code: after a
  change of the state's version, the running sessions lose their photos. The cwd's checkout is then
  measured over its whole dirty tree at the next Stop, where dirt that predates the session can block
  once per failing set, and the other checkouts go unchecked until an edit there photographs them
  again; the changes made before the change of version are not measured.
- A root outside git has no checkout: nothing is photographed and nothing is checked there. `doctor`
  says so; the Stop does not.

## Landing guard

- `pre-bash`, a PreToolUse hook on Bash, runs in every repository, with or without
  `.claude/agent-hooks.jsonc`. It reads each simple command of the call as Bash splits it (quotes,
  heredocs, `cd`, a subshell, `bash -c`, `eval`) and judges each `git push`, `gh pr merge`,
  `gh release create` and run of a `scripts/release.<ext>` in the repository it acts on, `git -C`,
  `--git-dir` and linked worktrees included.
- A repository whose agents land on their own declares its branches in its own file:
  `"profile": { "landing": { "trunk": "dev", "release": "main" } }`, never read from a preset. The
  guard then refuses a push to `release` (a deletion, `--all` and `--mirror` included), a force push or
  a deletion of `trunk`, a `gh pr merge` into `release`, with a check not green or none reported yet, or
  not mergeable, `gh release create`, and `scripts/release.<ext>` (its `--dry-run` passes). Each
  refusal names the way through: push to `trunk`, or `bun ./scripts/land.ts <branch>` when the
  repository has that script.
- Without a profile, it refuses a push or a `gh pr merge` to the default branch of a public repository.
  The visibility and the default branch come from `gh repo view`, read once per repository and session
  into `~/.local/state/agent-hooks/github__<session>.json`. A lookup that fails lets the command through
  with a `systemMessage` that starts with `agent-hooks:`; so does an invalid config file, judged by this
  default. A remote that names no `host/owner/name` (a local path) is not checked.
- The profile read is the one of the repository around the command's directory: `gh pr merge --repo`
  and `gh release create --repo` take the default.
- Not read: a git alias, a variable or a substitution in a refspec or a `cd` target (the `cd` leaves the
  directory where it was), a `$(…)` inside double quotes, a script fed on stdin, `gh api`. The Codex
  wiring calls no `pre-bash`.
