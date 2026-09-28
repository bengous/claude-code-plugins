# Installed plugins and release checks

[Plugin testing index](../plugin-testing.md). Read to check a plugin through the marketplace. Catalog activation and recovery are in [managed plugin catalog](catalog.md).

## Installed copies

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
  The catalog service explicitly updates changed user entries after activation. What the
  answer changes here is narrow: a pending bump moves the copy and the entry,
  not the files a session of this marketplace runs.

## Check a release from the marketplace

Run this once per release. It is the only path that exercises what a consumer
gets: the catalog entry, the enable flag in the user's settings, and the
plugin loaded with no `--plugin-dir`. Read the state before touching it:
`claude plugin list`, plus the four files above. A plugin the release
replaces must already be disabled, and disabling one is the owner's call, not
the checker's: if it is enabled, stop and say so.

1. Bump `plugin.json` and commit. `pre-commit` writes the version into
   `marketplace.json` and the README row. Land on `dev` and wait for catalog
   sync before checking the managed marketplace.
2. `claude plugin install <plugin>@<marketplace>`, or `claude plugin update
   <plugin>` when an older version is installed. It answers in seconds, and
   the cache holds every file when it returns.
3. `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate <cache path>`
   prints the same hooks and `$` calls there as it does on the source tree.
4. Use a throwaway `CLAUDE_CONFIG_DIR` for the permission check. Register the
   catalog and install the plugin in that config first, with the same
   `CLAUDE_CONFIG_DIR` on both commands. Authenticate that config if needed.
   Do not copy the live settings or their catalog Read grant. Launch from a
   scratch workspace with no local grants, neither `--plugin-dir` nor
   `--setting-sources project`. The temporary user's enable flag must load.

   ```bash
   cd <workspace> && env CLAUDE_CONFIG_DIR=<run>/claude-config \
     CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 <mise>/claude \
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
  `<repo>/<plugin>/src/runtime/server/cli.ts` in its argv. Every plugin of that marketplace
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
