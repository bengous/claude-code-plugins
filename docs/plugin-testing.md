# Testing a plugin from source

How to validate a plugin (skills, permissions, flow) before a release.
Every rule below was paid for during the git-sweep 3.0.0 fusion.

## Launch a test session

```bash
command claude --permission-mode default --plugin-dir <repo>/<plugin>
```

- `command claude`, not `claude`: the owner's shell function injects
  `--dangerously-skip-permissions` into every plain `claude` launch, and it
  does not check for `--permission-mode` before doing so.
- `--plugin-dir` reads the plugin source at process launch. No version bump,
  no cache write, no `plugin-cache-sync`.
- Since 2.1.265 the flag also accepts a folder of plugins: every child with a
  manifest loads, and children added or removed while running are picked up.
  It does nothing on this repo's root, whose `.claude-plugin/` holds only
  `marketplace.json` — the root is read as a plugin candidate and no child
  loads. Measured by diffing transcripts with and without the flag: identical.
  Pass one `--plugin-dir` per plugin here, or point it at a folder that
  carries no `.claude-plugin/`.
- The flag adds, it never replaces. Installed plugins, external ones included,
  stay loaded beside what it reads from disk. A plugin that is both installed
  and passed to the flag loads once, from the flag: the debug log of 2.1.270
  says `Plugin "github-flow" from --plugin-dir overrides installed version`,
  and its hooks fire once.
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
- `AskUserQuestion` was not available in `-p` on Claude Code 2.1.270. Put the
  answers in the prompt, or record that the flow needs a person.
- The `/<skill>` must open the prompt. Written after other text, it reaches
  the model as a `Skill` tool call, and a skill that carries `allowed-tools`
  prompts on that call in `default` mode: the `-p` run records a `Skill`
  denial with `Execute skill: <plugin>:<skill>` and the model improvises from
  the file. The same skill without `allowed-tools` runs. Measured on 2.1.270.
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
  symlink also checks the link target; `readlink` does not. Measured on
  Claude Code 2.1.270.
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
  matches `Bash(git -c sequence.editor=:*)` (measured on git 1.0.1).
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
`Loading hooks from plugin: <name>`. Measured on 2.1.270 with `github-flow`.

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

A plugin whose `hooks/hooks.json` names `modules` is a hooks module: one
TypeScript file exporting `register(on, options)`, run by the engine in an
environment of its own. Measured on 2.1.272 with `vellum`.

- Launch with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` until function hooks ship
  publicly. Without it the module never loads and the plugin's skills run as
  if it were not there; with it the debug log says
  `hooks module <name> loaded (worker, environment 1, tier user); events: ...`.
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
  State the module must keep across a reload goes to `$.store`.
- `claude plugin test <dir>` runs `*.test.ts` files that import
  `claude-code/testing` in the engine's environment. Two limits on 2.1.272:
  its `$` has no `classic` noun, so a `classic.PermissionRequest` hook cannot
  be raised from a test; and `bun test` at the repo root picks the same
  `*.test.ts` files up and fails on the import. `vellum` tests its module with
  `bun test` instead: `register` is called with a recording `on` and a `$`
  answered from memory (`vellum/hooks/register.test.ts`).
- A hook answers within its dispatch's budget, about ten seconds. What must
  wait for a person (a browser decision) is polled by `$.clock.every` and
  handed to the session by `$.prompt.submit`, which runs once the session is
  idle. The prompt shows as `Prompt from the <plugin> plugin`, framed by
  Claude Code as a message to address; a text that points at a file the
  session can read worked on Opus 5 and Sonnet 5 (`spike-results.md` in
  `plans/2026-09-15/plan-review-rewrite/`, facts 5 to 9).
- `$.process.run` reads the whole output, so a server started from a hook
  must be spawned detached by a launcher that relays one line and exits.
  Nothing tells a detached process that the session ended: give it a
  heartbeat from `$.clock.every` and let it exit when the beat stops.

## Prompt audit

`/claude-api prompt-audit "<plugin>/skills"` finds text written for an
older model or an older backend: fossil sentences, hardcoded depths, gold
outputs the model copies, descriptions without a trigger clause. One pass
over `git/skills` found the `rebase` fossil and three `squash` defects.
Run it on a plugin before its release bump; apply only the hunks the test
session above confirms. Skills here are written by agents under the owner's
prompting, so no line carries an author's measured intent: a recent commit
date does not exempt a pattern, numeric length caps included.

## Install and update

`bengous-plugins` is registered as a `directory` source pointing at this
working tree, so the catalog is the tree and there is no fetch step.

- An install is a copy, not a link: `git/README.md` holds inode 59059395 here
  and 59085089 in the cache. An installed plugin is therefore frozen at the
  state it was installed from, and a later `git switch` does not reach it.
- Update detection reads the catalog's `version` field and nothing else.
  Rewrite a `SKILL.md` in full, leave `plugin.json` at the same version, and
  the cache stays untouched. Bump the version, then run
  `claude plugin update <name>` and restart. Each version lands in its own
  directory, so `1.0.0/` and `1.0.1/` coexist.
- Plugin state lives in four places, none of which `--plugin-dir` writes to:
  `~/.claude/settings.json` for `enabledPlugins` and `extraKnownMarketplaces`,
  `known_marketplaces.json` for where each catalog is read,
  `installed_plugins.json` for version, path and scope, and `cache/` for the
  copies.
- Unresolved: whether an interactive session auto-updates from a `directory`
  marketplace. `bengous-plugins` carries `autoUpdate: true`, yet four `-p`
  sessions left a pending bump uninstalled, one with
  `FORCE_AUTOUPDATE_PLUGINS=1`. Headless may skip the background updater.
  Until someone measures an interactive session, update by hand.
