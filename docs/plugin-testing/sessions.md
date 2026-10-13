# Plugin test sessions

[Plugin testing index](../plugin-testing.md). Read for source launches, isolated permissions and transcript evidence.

## Launch a test session

```bash
command claude --permission-mode default --plugin-dir <repo>/<plugin>
```

`scripts/try-plugin.ts` is that launch with `--debug`, the function-hooks flag and the
plugin's `bun install`. The owner's shell calls it `tp`.

- `try-plugin.ts` alone asks two questions through `fzf`: which plugin, then which
  source. The first screen carries each plugin's installed version, its version on
  `dev`, and whether work on it exists outside `dev`; the second, each source's version,
  where it sits on disk, the date of its last commit on that plugin and how far ahead of
  `dev` it runs. `Esc` on either leaves at `130`, having launched and created nothing.
- `try-plugin.ts <plugin>` skips the first screen.
- `try-plugin.ts <plugin>... [-- <claude args>]` skips both screens and reads the
  checkout it is run from.
- `try-plugin.ts --list` prints one plugin name per line, for shell completion.

A source is a worktree on disk, or a ref carrying commits on that plugin `dev` does not
have. Version numbers decide nothing: the histories here were rewritten, so a ref can
sit at `dev`'s version and still hold three commits `dev` never saw.

Picking a ref with no worktree **creates one** under `<main checkout>.wt/<ref>` and
leaves it there; nothing cleans it up. A remote ref with no local branch lands on a
detached HEAD, and the screen says so before the session starts.

It reads the checkout it is run from, and the one it lives in when the shell sits
outside the repository, so it also works from `/tmp`.

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
