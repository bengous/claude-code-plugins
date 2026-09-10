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
  stay loaded beside what it reads from disk — so a plugin that is both
  installed and passed to the flag registers its skills twice.
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

- `bypassPermissions` and `auto` (the owner's global `defaultMode: dontAsk`)
  auto-approve; a session in either proves nothing about `allowed-tools`.
  Only `default` mode surfaces the prompts that reveal a coverage gap.
- An "always allow" click persists into `~/.claude/settings.local.json` and
  masks the same gap in every later session. Before concluding that a
  frontmatter fix works, check that file for a grant that covers it.

## Process traps

- `/clear` starts a new session id but keeps the CLI process, and the process
  loaded plugin files at launch. Retesting an edited `SKILL.md` needs a new
  process, not a `/clear`.
- Plant a version marker before retesting: one `Inputs` line whose rendered
  value differs between the old and the new file proves which version loaded.

## Headless conclusive test

```bash
command claude -p --permission-mode default --plugin-dir <plugin> "/<skill> <args>"
```

- `!` preprocessing failures land on stderr before the model runs. Empty
  stderr means the skill's `allowed-tools` covers its `Inputs`.
- In `-p`, a prompt becomes a denial. A full run without one validates the
  allowlist for the whole flow, stronger than an interactive pass.

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
