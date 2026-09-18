# Testing a plugin from source

How to validate a plugin (skills, permissions, flow) before a release.

## Launch a test session

```bash
command claude --permission-mode default --plugin-dir <repo>/<plugin>
```

- `command claude`, not `claude`: the owner's shell function injects
  `--dangerously-skip-permissions` into every plain `claude` launch, and it
  does not check for `--permission-mode` before doing so.
- `--plugin-dir` reads the plugin source at process launch. No version bump,
  no cache write, no `plugin-cache-sync`.
- The flag also accepts a folder of plugins: every child with a manifest
  loads, and children added or removed while running are picked up.
  It does nothing on this repo's root, whose `.claude-plugin/` holds only
  `marketplace.json` — the root is read as a plugin candidate and no child
  loads. Measured by diffing transcripts with and without the flag: identical.
  Pass one `--plugin-dir` per plugin here, or point it at a folder that
  carries no `.claude-plugin/`.
- The flag adds, it never replaces. Installed plugins, external ones included,
  stay loaded beside what it reads from disk. A plugin that is both installed
  and passed to the flag loads once, from the flag: the debug log says
  `Plugin "<name>" from --plugin-dir overrides installed version`, and its
  hooks fire once.
- A skill that rewrites history needs a clean tree, and the tree that holds
  the skill under edit is dirty by definition. Run the session in a second
  worktree (`git worktree add /tmp/t <branch>`) while `--plugin-dir` keeps
  pointing at the edited source. One fresh branch per run: a rerun on a
  branch the first run rewrote no longer finds its hashes.
- Reproduce a git mechanism in a scratch repo before editing the skill:
  three `git commit -qm` and one `git rebase -i` under
  `-c sequence.editor=cat` show the real todo format (here
  `pick <hash> # <subject>`) and settle a question in seconds that a
  full session answers in minutes.

## Permission modes are not equal tests

- `bypassPermissions` and `auto` (the owner's global `defaultMode: auto`)
  auto-approve; a session in either proves nothing about `allowed-tools`.
  Only `default` mode surfaces the prompts that reveal a coverage gap.
- An "always allow" click persists into `~/.claude/settings.local.json` and
  masks the same gap in every later session. Before concluding that a
  frontmatter fix works, check that file for a grant that covers it.
- User and local `allow` rules mask a gap the same way: the owner's
  `Bash(mkdir:*)` or `Bash(echo:*)` approves what a skill's `allowed-tools`
  misses. `--setting-sources project`, run from a scratch directory without
  `.claude/settings.json`, leaves `allowed-tools` as the only grant.

## Process traps

- `/clear` starts a new session id but keeps the CLI process, and the process
  loaded plugin files at launch. Retesting an edited `SKILL.md` needs a new
  process, not a `/clear`.
- Plant a version marker before retesting: one `Inputs` line whose rendered
  value differs between the old and the new file proves which version loaded.

## Headless conclusive test

```bash
command claude -p --permission-mode default --setting-sources project \
  --output-format json --plugin-dir <plugin> "/<skill> <args>"
```

- `!` preprocessing failures land on stderr before the model runs. Empty
  stderr means the skill's `allowed-tools` covers its `Inputs`.
- In `-p`, a prompt becomes a denial. A full run without one validates the
  allowlist for the whole flow, stronger than an interactive pass.
- The final JSON object lists each denial in `permission_denials`. An
  `is_error` tool result also marks a non-zero exit, such as `test -f` on a
  missing file: read each one before calling it a gap.
- `AskUserQuestion` is not available in `-p`. Put the answers in the prompt,
  or record that the flow needs a person.
- The `/<skill>` must open the prompt. Written after other text, it reaches
  the model as a `Skill` tool call, and a skill that carries `allowed-tools`
  prompts on that call in `default` mode: the `-p` run records a `Skill`
  denial with `Execute skill: <plugin>:<skill>` and the model improvises from
  the file. The same skill without `allowed-tools` runs.
- A background task ends about five seconds after the final result, so a flow
  that waits for a background exit notification (`pair-planning`) stops there.
- A flow that writes under `~` runs against a throwaway home:
  `HOME=<tmp> CLAUDE_CONFIG_DIR=<real home>/.claude` keeps the login and moves
  every `~` path, rule paths included. Prepend `<tmp>/.local/bin` to `PATH`
  when the flow runs what it installs.

## Verify through transcripts

Transcripts live at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`.

- Read the `permission-mode` rows first; a bypass or auto session invalidates
  any permission conclusion drawn from it.
- The rendered `## Inputs` values show whether `!` interpolation ran and which
  file version the process had loaded.

## Skill mechanics worth knowing

- `` !`cmd` `` interpolation works in `SKILL.md`. The permission check walks
  every head of a compound command; its error names the blocking part
  (`test` in `test -f … && echo …`), the rest already passed.
- A fenced ```` ```! ```` block runs its whole body as one bash script:
  multi-line pipelines and `#` comments work, and only stdout reaches the
  model. A non-zero exit aborts the skill; end the pipeline with `|| true`.
- That permission check also applies the Bash tool's shell-safety
  heuristics, and `allowed-tools` cannot override them. A brace next to a
  quote is "expansion obfuscation"; a backslash-newline is "backslash-escaped
  whitespace". Either aborts the skill before the model runs, with the reason
  in the transcript's `<local-command-stderr>` row, not on stderr.
- `Bash(*:*)` does not grant a bundled-script call: `:*` is a trailing
  wildcard, so it reads as `Bash(* *)`, a literal-star prefix. `Bash(*)` is
  the match-all form; `Bash(${CLAUDE_PLUGIN_ROOT}/scripts/x *)` the narrow
  one. Auto-approving modes hide the gap; only `default` mode shows it.
- File rules take gitignore paths, and only `Read(path)` and `Edit(path)` are
  consulted; `Edit` covers `Write`. `Write(*:*)` grants nothing: a Write to
  `/tmp` still prompts in `default` mode. An absolute path needs two slashes,
  `Edit(//tmp/name*)`, and an allow rule on a symlinked path such as macOS
  `/tmp` needs the target to match too; `Edit(~/.cache/x/**)` avoids both.
  Source: https://code.claude.com/docs/en/permissions#read-and-edit.
- `${CLAUDE_PLUGIN_ROOT}` expands in `Bash(...)` rules only:
  `Read(${CLAUDE_PLUGIN_ROOT}/x)` matches nothing. A plugin file outside the
  working directory prompts on `Read`, installed cache included. An installed
  copy is reachable with `Read(~/.claude/plugins/cache/*/<plugin>/*/<path>)`;
  a `--plugin-dir` session still prompts.
- A `Bash` rule approves the command, not its path arguments. `cat`, `ls`,
  `grep`, `cmp` and `file` on a path outside the working directories stay
  blocked until a `Read(path)` rule covers it; an `Edit(path)` rule alone
  does not. `cp` needs `Edit(path)` on its source as well, and a flag
  (`cp -f`) prompts whatever the rules say. `ls -l` on a
  symlink also checks the link target; `readlink` does not.
- Past the executable, quotes in a rule are literal:
  `Bash(ln -sf "${CLAUDE_PLUGIN_ROOT}/x" *)` matches only the quoted command.
  A rule quoted around the executable, `Bash("${CLAUDE_PLUGIN_ROOT}/x":*)`,
  misses a command continued over `\` line breaks;
  `Bash(${CLAUDE_PLUGIN_ROOT}/x *)` matches the quoted executable on one line
  or several.
- A write under `.claude/` prompts whatever `allowed-tools` says:
  `Edit(./.claude/**)` grants nothing there, and a `cp` out of the installed
  plugin cache counts as one. `ln -s` from the cache passes.
- `Read`, `Grep`, `Glob`, `Agent` and `AskUserQuestion` need no approval in
  the working directory, so `Grep(*:*)`, `Glob(*:*)`, `Agent(*:*)` and
  `AskUserQuestion(*:*)` grant nothing.
  Source: https://code.claude.com/docs/en/tools-reference.
- An `allow` rule stops at a leading environment assignment.
  `Bash(git rebase:*)` never matches `GIT_SEQUENCE_EDITOR=x git rebase`, in
  `default` mode it prompts every time; only a fixed known-safe list
  (`NODE_ENV`-style) is stripped, and `deny`/`ask` rules match past any
  assignment. Keep the executable first: `git -c sequence.editor=x rebase`
  matches `Bash(git -c sequence.editor=:*)`.
  Source: https://code.claude.com/docs/en/permissions#process-wrappers.
- The session exports `GIT_EDITOR=true`. It outranks `-c core.editor`, so a
  `core.editor="cp msg"` override never runs and a squash keeps git's
  concatenated message. Set the message from the todo instead:
  `sed -e '/^squash <h>/a exec git commit --amend -F <file>'`.
- `$(...)` in a command prompts in `default` mode even under a matching rule
  ("Contains command_substitution"). The model copies example commands as
  written, so `git branch backup-$(date +%s)` in a skill is a prompt on
  every run.
- `${CLAUDE_PLUGIN_ROOT}` is substituted in `SKILL.md` at load, never in a
  file the model opens with `Read`. Sibling phase files must locate the
  plugin root relative to the skill base directory the harness prints.
- `disable-model-invocation: true` on a skill removes its description from
  model context; commands and model-invocable skills keep theirs loaded in
  every session. Phase files opened with `Read` cost zero standing context,
  which is why git-sweep carries `audit.md`/`apply.md` instead of commands.
- An installed plugin is the source tree copied verbatim into
  `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, executable
  bits included. A layout that works under `--plugin-dir` works installed.

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
under the rule on `$` below.

- Launch with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` until function hooks ship
  publicly. Without it the module never loads and the plugin's skills run as
  if it were not there; with it the debug log says
  `hooks module <name> loaded (worker, environment 1, tier user); events: ...`.
- To read that line headless, give `--debug-file <path>` and the prompt on
  stdin: `--debug` alone prints nothing under `-p`, and `--plugin-dir` takes
  the positional prompt, so `claude -p --plugin-dir <plugin> "say ok"` fails
  with `Input must be provided either through stdin or as a prompt argument`.
- A hook that throws or overruns is skipped, and what is beneath it runs in
  its place. For a `tool.check` hook that is a lock, that is fail-open: the
  write the hook meant to refuse goes through on the engine's own verdict.
  `on(...).catch(($, e, next) => ...)` on the registration is how such a hook
  fails closed; `next.error.kind` says `throw` or `timeout`, and
  `claude plugin validate` lists the hook without saying a handler is there.
- A hooks module may span several files, but `$` may not: the loader follows
  it only into a function declared in the file that registers the hook, and
  refuses a noun passed on its own (`$.store is used as a value`). Every other
  file takes a plain record of closures instead, bound where `$` is in scope
  (`vellum/src/core/engine/host.ts`, `mods/diff/hooks/host/host.ts`).
- `hooks/hooks.json` stays where it is, and the module it names does not have
  to: `"modules": ["../src/core/engine/register.ts"]` loads under
  `--plugin-dir`, `validate` and the kit. Not measured: that entry loaded from
  the copy an install puts in the cache.
- One hooks module per plugin. A second entry in `modules` is refused by
  `claude plugin validate` (`modules names one hooks module per plugin; a
  second entry is refused`), and `claude plugin test` then finds no module to
  load.
- One hook per event and matcher. A second `on("turn.complete", ...)` without
  a matcher keeps the module from loading: `on("turn.complete") is registered
  twice without a matcher`. So a plugin made of parts keeps each event's one
  hook in the registering file and calls the parts' handlers from it, each
  handed the record of closures; measured under `validate` and the kit with a
  handler imported from another directory of the plugin.
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate <plugin>` reads
  the module's source and prints what it hooks (`skill.prompt{skill=...}`)
  and every `$` call with the function that makes it. It needs no login and
  runs in the repo's gates. Run it first: a hook the engine does not list is a
  hook that will not fire.
- `/plugin-types <plugin>/types` writes the contract of the running build;
  regenerate it after each Claude Code update. It runs headless too:
  `claude -p --setting-sources project "/plugin-types <plugin>/types"`. Keep
  `claude-code.d.ts` only; the `-mcp` and `-plugins` files describe the
  developer's own session.
- A plugin with `package.json` + `bun.lock` gets `bun install
  --frozen-lockfile --ignore-scripts` at its cache when installed. Under
  `--plugin-dir` nothing installs: run `bun install --cwd <plugin>` yourself,
  as `scripts/run-gates.ts` does for `vellum`.
- Saving a file under `--plugin-dir` reloads the module: `register` runs
  again in a fresh environment and every pending timer of the old one dies.
  State the module must keep across a reload goes to `$.store`. The transcript
  says the reload landed, `<name>: reloaded (5 hooks: session.start,
  skill.prompt, command.run, tool.check, tool.call)`, counting distinct events,
  so two hooks on one event read as one.
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
- A hook answers within its dispatch's budget, about ten seconds. What must
  wait for a person (a browser decision) is polled by `$.clock.every` and
  handed to the session by `$.prompt.submit`, which runs once the session is
  idle. The prompt shows as `Prompt from the <plugin> plugin`, framed by
  Claude Code as a message to address; a text that points at a file the
  session can read works (`spike-results.md` in
  `plans/2026-09-15/plan-review-rewrite/`).
- `$.process.run` reads the whole output, so a server started from a hook
  must be spawned detached by a launcher that relays one line and exits.
  Nothing tells a detached process that the session ended: give it a
  heartbeat from `$.clock.every` and let it exit when the beat stops.
- A plugin can hold a mode of its own instead of borrowing a native one. The
  three pieces, measured together (`spike-results.md` facts 13 to 20): a
  `tool.check` hook as the lock, a `$.tool.register` tool as the model's
  explicit signal, a skill as the way out. Each is an engine event or a server
  answer, so nothing rides on the model remembering to call something.
- A `tool.check` deny from a module reaches the model as
  `Permission to use <Tool> denied by plugin <name>: <reason>`, in `default`
  mode and in `auto` mode alike; a hook's deny is not overridden by the mode.
  Returning `next(e)` instead leaves the session's own mode to decide, so a
  write a plugin means to allow still prompts in `default`: answer
  `{ decision: "allow" }` for the paths the plugin owns.
- `next(e)` there carries `rule` when a settings allow rule decided
  (`{"decision":"allow","rule":"Bash(mkdir:*)"}`), and leaves it out when the
  mode or the tool's own check did. That is how a plugin tells a user's
  standing grant from the engine's own verdict.
- `$.command.register({ name: "stop" })` is listed as `/stop`, with no plugin
  prefix; only skills and markdown commands get `/<plugin>:<name>`. Its
  `{ text }` prints under the plugin's name and starts no model turn. A way in
  or out that must stay in the plugin's namespace is a skill instead, with
  `disable-model-invocation: true` so only the person runs it, closed on the
  plugin's own `skill.prompt` hook.
- `claude plugin validate` prints each matcher's **source text**, not its
  value: a matcher written `{ command: STOP.name }` is reported as
  `command.run{command=STOP.name}`. Write matchers as string literals. Two
  hooks on one event are two entries, each with its own matcher.
- Saving a file under `--plugin-dir` prints `<plugin>: reloaded (N hooks: …)`
  and raises `session.start` again for that plugin alone, so a mode kept in
  `$.store` can be restored there. Registering the same tool or command name
  again replaces it, with no warning and no duplicate in the typeahead.
- A registered tool's result text is what the model acts on:
  `Plan vN is under review in the browser. End your turn; the review arrives
  as a prompt.` ended Opus 5's turn every time. `vellum` now answers the
  shorter `Plan vN under review. End your turn.`, whose effect on the turn is
  not measured in a live session yet.

### What the contract and the docs say

Read from `vellum/types/claude-code.d.ts` (symbol names below) and from the
official docs (page § section). Neither is measured in a session; each is
what the engine's own text commits to. Function hooks are early access and
absent from the public docs: the `.d.ts` is their only reference.

- `tool.check` (`ToolCheckInput`, `ToolCheckDecision`) fires when the engine
  decides whether a call may run, after `tool.call` and `PreToolUse`.
  `next(e)` is the engine's own verdict `{ decision, reason?, rule? }`; a hook
  may return any `allow | ask | deny`, and the last word up the chain wins.
  `deny`'s `reason` is what the model reads. Its input has no agent id: it
  fires for subagents too.
- `$.tool.register` (`ToolSpec`) declares `mcp__<plugin>__<name>`; a
  `tool.call` hook on that name serves it by returning `{ result }` without
  `next`, and a call no hook answers fails. An unmatched `tool.call` hook that
  compares `e.tool` serves it as well (measured in the kit, `claude plugin
  test`), which is how a module serves tools whose names are not literals in
  its registering file. `$.command.register`
  (`CommandSpec`) declares `/<name>`, served by a `command.run` hook returning
  `{ text }`. Both reject until `session.start`, whose first raise is awaited,
  so registering there lists them by turn one (`'session.start'`). `/clear`
  does not raise `session.start` again.
- `$.prompt.submit` (`PromptSubmitInput`, `PromptSubmitResult`) runs when the
  session is idle; its promise resolves once the prompt entered or was queued
  behind the running turn, not when it is delivered. A prompt queued mid-turn
  lands at the next idle, however far away.
- A hook's budget is about ten seconds of real time (`Mock.clock`); the
  engine skips a hook that overruns it and runs what is beneath in its place.
- Bash's built-in read-only set runs without a prompt "in every mode"
  (permissions § Read-only commands), and plan mode adds nothing for Bash:
  commands outside the set go through the session's regular permission flow
  (permission-modes § plan mode). What plan mode changes is file edits:
  "never auto-approved, even when an allow rule matches", and file-modifying
  shell commands such as `touch` and `rm` too (agent-sdk permissions § Plan
  mode).
- `Stop` hooks "don't fire on user interrupts" (hooks-guide § Limitations).
  Interrupting while a hook callback is pending cancels the pending tool call
  (agent-sdk hooks § Hook timeout). A command hook that outlives the answer
  the user gave in the terminal keeps running until its own timeout
  (`spike-results.md`).

## Prompt audit

`/claude-api prompt-audit "<plugin>/skills"` finds text written for an
older model or an older backend: fossil sentences, hardcoded depths, gold
outputs the model copies, descriptions without a trigger clause.
Run it on a plugin before its release bump; apply only the hunks the test
session above confirms. Skills here are written by agents under the owner's
prompting, so no line carries an author's measured intent: a recent commit
date does not exempt a pattern, numeric length caps included.

## Install and update

`bengous-plugins` is registered as a `directory` source pointing at this
working tree, so the catalog is the tree and there is no fetch step.

- An install is a copy, not a link: `ls -i` shows a different inode for a
  file in the tree and its cache copy. The copy is frozen at the state it was
  installed from, and a later `git switch` does not reach it. What a session
  loads is another matter, measured below: from a `directory` marketplace it
  is the tree, not the copy.
- Update detection reads the catalog's `version` field and nothing else.
  Rewrite a `SKILL.md` in full, leave `plugin.json` at the same version, and
  the cache stays untouched. Bump the version, then run
  `claude plugin update <name>` and restart. Each version lands in its own
  directory, so the old and the new version coexist.
- Plugin state lives in four places, none of which `--plugin-dir` writes to:
  `~/.claude/settings.json` for `enabledPlugins` and `extraKnownMarketplaces`,
  `known_marketplaces.json` for where each catalog is read,
  `installed_plugins.json` for version, path and scope, and `cache/` for the
  copies.
- Unresolved: whether an interactive session auto-updates from a `directory`
  marketplace. `bengous-plugins` carries `autoUpdate: true`, yet repeated `-p`
  sessions left a pending bump uninstalled, one of them with
  `FORCE_AUTOUPDATE_PLUGINS=1`. Headless may skip the background updater.
  Until someone measures an interactive session, update by hand. What the
  answer changes here is narrow: a pending bump moves the copy and the entry,
  not the files a session of this marketplace runs.

### Check a release from the marketplace

Run this once per release. It is the only path that exercises what a consumer
gets: the catalog entry, the enable flag in the user's settings, and the
plugin loaded with no `--plugin-dir`. Read the state before touching it:
`claude plugin list`, plus the four files above. A plugin the release
replaces must already be disabled, and disabling one is the owner's call, not
the checker's: if it is enabled, stop and say so.

1. Bump `plugin.json` and commit. `pre-commit` writes the version into
   `marketplace.json` and the README row; the catalog is the tree, so the
   installer sees the bump as soon as it is committed.
2. `claude plugin install <plugin>@<marketplace>`, or `claude plugin update
   <plugin>` when an older version is installed. It answers in seconds, and
   the cache holds every file when it returns.
3. `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate <cache path>`
   prints the same hooks and `$` calls there as it does on the source tree.
4. Launch from a scratch workspace, with neither `--plugin-dir` nor
   `--setting-sources project`: the enable flag lives in the user's settings,
   and the workspace's own `.claude/settings.json` still loads beside it.

   ```bash
   cd <workspace> && env CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 <mise>/claude \
     --permission-mode default --model opus --debug-file <run>/s.debug.log
   ```

5. Run the plugin's own full round. For `vellum`: `/vellum:start`, a mockup, a
   comment sent while the model still drafts, `plan.md` with a code block and
   a `mermaid` block, `mcp__vellum__submit`, a comment on the diagram and one
   on an element of the mockup, the revision and its `submit`, Approve. The
   round must show the directory renamed, the model told where the plan
   lives, one version per `submit`, and no `ExitPlanMode` in the transcript.

What the debug log proves, and what it does not:

- The install writes three things and nothing else: one key in
  `enabledPlugins`, one entry in `installed_plugins.json` (scope, install
  path, version, both timestamps, and the marketplace's `gitCommitSha`), and
  the copy under `cache/`. `known_marketplaces.json` stays as it was.
- A session does not read that copy when the marketplace is a `directory`.
  The log names the tree: `Read hooks.json for plugin <name> (enabled=true):
  <repo>/<plugin>/hooks/hooks.json`, the skills load from
  `<repo>/<plugin>/skills`, and a server the module spawns carries
  `<repo>/<plugin>/src/core/server/cli.ts` in its argv. Every plugin of that marketplace
  resolves the same way in one log, while plugins of a `github` marketplace
  resolve under `cache/`. So `plugin.register: <name> (user,
  <name>@<marketplace>)` is the line that proves the install path was taken;
  the file paths prove nothing about the copy.
- The copy carries what git ignores, `node_modules/` included, and its files
  are plain copies: link count 1, against the tree's own hardlinks into bun's
  package cache. That leaves `bun install --frozen-lockfile --ignore-scripts`
  nothing to fetch, so whether Claude Code ran it cannot be read off the
  result.
- The skill's reference files are outside the working directory, so each one
  prompts on `Read` in `default` mode, and the rule the terminal offers names
  the tree's path. Answer them one at a time: the standing grant would mask
  the same gap in every later session.
