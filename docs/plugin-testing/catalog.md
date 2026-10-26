# Managed plugin catalog

[Plugin testing index](../plugin-testing.md). Read to activate, inspect, repair or undo automatic catalog synchronization.

`bengous-plugins` uses a `directory` source. Its catalog is the registered
working tree, not the installed cache. The managed target is
`~/Work/claude-code-plugins.wt/catalog`, detached on `origin/dev` and locked
with the reason `claude plugin catalog`.

`scripts/plugin-catalog.ts` owns `setup`, `sync`, and `status`. `setup` creates
that worktree next to the main checkout, locks it and installs each plugin's
dependencies. It also repairs a locked registration whose directory is gone.
`sync` finds the worktree by its lock reason, regardless of the caller's
checkout. It never fetches, pushes, or changes a branch ref.

The dotfiles units `claude-plugin-catalog.path` and
`claude-plugin-catalog.service` watch the main repository's
`.git/logs/refs/remotes/origin/dev`. After activation, a landing or a fetch
that advances that ref starts the script from the catalog. A PR branch push
does not trigger it. The script checks the ref again after its notification
and journal write, then repeats if another landing arrived during the run.

A plugin source change triggers a notification even without a version bump.
Changed `package.json` or `bun.lock` files trigger `bun install --cwd <plugin>
--frozen-lockfile`. Only installed user entries with a different catalog
version receive `claude plugin update --json --scope user <id>`. An installed
plugin absent from the catalog is skipped and shown as `not in catalog` by
`status`. Other scopes stay outside this automation.

The main checkout remains independent and can still need a manual pull.
Restart open sessions after a catalog change: hooks and reference reads can
observe new files while other session state still reflects the previous tree.
A session started during dependency installation can see old dependencies.
Whether `update` downgrades an installed entry after a revert is not measured;
`status` exposes a remaining version mismatch.

Each pass appends to `$XDG_STATE_HOME/claude-plugin-catalog/log.jsonl`, with
`~/.local/state` as the default state directory. Raw subprocess output goes
to the service journal. `status` reports the marketplace path, catalog HEAD,
`origin/dev`, tracked edits, path unit state, last report and entry versions.
`CLAUDE_CONFIG_DIR` selects the Claude state directory, default `~/.claude`.

Tracked edits block a sync. Restore the named unstaged edits with
`git -C <catalog> restore .`; inspect and unstage staged edits first.
An untracked file blocks only when Git refuses to overwrite it; inspect the
named file before removing it. Start `claude-plugin-catalog` after repair.
Install or update failures produce a critical notification and preserve the
full output in the report. Retry a failed install with `bun install --cwd
<catalog>/<plugin> --frozen-lockfile`; retry a failed entry update with
`claude plugin update --json --scope user <id>`. An already current catalog
does not replay failed steps. Notification failures appear as `notifyError`.
A script crash reaches `claude-plugin-catalog-failure@.service`. Once a fix
lands, recover with `git -C <catalog> checkout --detach origin/dev`, then
`systemctl --user start claude-plugin-catalog`.

## Activate

The units, activation template and Claude settings live in the dotfiles repo.
The service executes the catalog's copy of the script. The live sequence is:

1. Run `bun scripts/plugin-catalog.ts setup` from this repository, then apply
   only the three units and their activation script from the dotfiles. The
   script reloads systemd and enables the path unit.
2. Verify the path unit is enabled and active, and a fetch advances the
   catalog. Test another reflog write during a pass and the failure unit.
3. Redirect in place with `claude plugin marketplace add
   ~/Work/claude-code-plugins.wt/catalog`, then apply only the Claude settings
   source. Never remove the marketplace: removal uninstalls its plugins and
   removes their enable flags. Adding the same name at a new path preserves
   them, as measured in the approved plan's throwaway config.
4. Inspect a new session's debug log for catalog paths. Check
   `plugin-cache-sync status` and `try-plugin`, then observe a real landing.

These live checks remain unmeasured by the disposable-repository tests in
`scripts/plugin-catalog.integration.test.ts`. In particular, those tests use command
stubs and do not prove desktop notifications, engine loading, or unit
activation. The source settings include
`Read(~/Work/claude-code-plugins.wt/catalog/**)` so reference reads do not ask
for permission in ordinary sessions.

## Undo the catalog

1. Run `systemctl --user disable --now claude-plugin-catalog.path`.
2. Redirect in place with `claude plugin marketplace add
   ~/Work/claude-code-plugins`.
3. Remove the units and activation script from the dotfiles source, restore
   the marketplace path there, and remove the catalog Read grant. Record
   deleted targets in `.chezmoiremove`, then apply only those targets.
4. Run `git worktree unlock ~/Work/claude-code-plugins.wt/catalog`, then
   `git worktree remove ~/Work/claude-code-plugins.wt/catalog`.



For cache behavior and consumer checks, read [installed plugins and release checks](release.md).
