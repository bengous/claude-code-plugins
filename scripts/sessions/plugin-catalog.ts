#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const LOCK = "claude plugin catalog";

const MARKETPLACE = "bengous-plugins";

const MANIFEST = ".claude-plugin/marketplace.json";

interface CatalogEntry {
  name: string;
  source: string;
  version: string;
}

type CatalogMove =
  | { kind: "moved"; from: string; to: string }
  | { kind: "current"; at: string }
  | { kind: "blocked"; reason: string; files: string[] };

interface PluginChange {
  name: string;
  from: string;
  to: string;
  install: "ok" | "skipped" | { failed: string };
  entry: "updated" | "up-to-date" | "not-installed" | "same-version" | { failed: string };
}

interface SyncReport {
  at: string;
  catalog: CatalogMove;
  plugins: PluginChange[];
  notified: boolean;
  notifyError?: string;
}

interface Worktree {
  path: string;
  lock: string | undefined;
  detached: boolean;
}

interface InstalledEntry {
  scope: string;
  version: string;
}

interface Result {
  code: number;
  out: string;
  err: string;
}

function command(args: string[], cwd: string): Result {
  try {
    const result = Bun.spawnSync(args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });

    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  } catch (error) {
    return {
      code: 127,
      out: "",
      err: `${args[0]}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function git(repo: string, ...args: string[]): string {
  const result = command(["git", ...args], repo);

  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.err}${result.out}`);

  return result.out.trimEnd();
}

function repository(): string {
  return git(import.meta.dir, "rev-parse", "--show-toplevel");
}

function worktrees(repo: string): Worktree[] {
  return git(repo, "worktree", "list", "--porcelain", "-z")
    .split("\0\0")
    .filter(Boolean)
    .map((record) => {
      const fields = record.split("\0");
      const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);

      if (!path) throw new Error("git worktree list returned no path");

      return {
        path,
        lock: fields.find((field) => field.startsWith("locked "))?.slice(7),
        detached: fields.includes("detached"),
      };
    });
}

function findCatalog(repo: string): Worktree {
  const matches = worktrees(repo).filter((tree) => tree.lock === LOCK);

  if (matches.length === 0) throw new Error(`No worktree locked with reason: ${LOCK}`);

  if (matches.length !== 1) throw new Error(`Multiple worktrees locked with reason: ${LOCK}`);
  const catalog = matches[0]!;

  if (!catalog.detached) throw new Error(`Catalog must be detached: ${catalog.path}`);

  return catalog;
}

function catalogEntries(repo: string, ref: string): CatalogEntry[] {
  const manifest: { name: string; plugins: CatalogEntry[] } = JSON.parse(
    git(repo, "show", `${ref}:${MANIFEST}`),
  );

  if (manifest.name !== MARKETPLACE || !Array.isArray(manifest.plugins))
    throw new Error(`Invalid ${MANIFEST}`);

  for (const plugin of manifest.plugins) {
    if (
      plugin.name.length === 0 ||
      plugin.version.length === 0 ||
      !plugin.source.startsWith("./") ||
      plugin.source.split("/").includes("..")
    )
      throw new Error(`Invalid catalog entry: ${JSON.stringify(plugin)}`);
  }

  return manifest.plugins;
}

export function changedPlugins(paths: string[], before: CatalogEntry[], after: CatalogEntry[]) {
  const names = new Set([...before, ...after].map((plugin) => plugin.name));

  return [...names].flatMap((name) => {
    const old = before.find((plugin) => plugin.name === name);
    const next = after.find((plugin) => plugin.name === name);

    const sources = [
      ...new Set(
        [old?.source, next?.source].flatMap((source) =>
          source === undefined ? [] : [source.slice(2).replace(/\/$/u, "")],
        ),
      ),
    ];

    if (
      !paths.some((path) => sources.some((source) => path.startsWith(`${source}/`))) &&
      old?.version === next?.version &&
      old?.source === next?.source
    )
      return [];

    return [
      {
        name,
        from: old?.version ?? "not in catalog",
        to: next?.version ?? "not in catalog",
        depsChanged: paths.some((path) =>
          sources.some(
            (source) => path === `${source}/package.json` || path === `${source}/bun.lock`,
          ),
        ),
      },
    ];
  });
}

function statePath(): string {
  return join(
    process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local/state"),
    "claude-plugin-catalog/log.jsonl",
  );
}

function configPath(file: string): string {
  return join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "plugins", file);
}

function installedEntries(): Map<string, InstalledEntry> {
  const path = configPath("installed_plugins.json");

  if (!existsSync(path)) return new Map();

  const data: { plugins: Record<string, InstalledEntry[]> } = JSON.parse(
    readFileSync(path, "utf8"),
  );

  return new Map(
    Object.entries(data.plugins).flatMap(([id, entries]) => {
      const entry = entries.find((candidate) => candidate.scope === "user");

      return entry && id.endsWith(`@${MARKETPLACE}`)
        ? [[id.slice(0, -MARKETPLACE.length - 1), entry]]
        : [];
    }),
  );
}

function rawOutput(result: Result): string {
  const output = `${result.out}${result.err}`.trim();

  if (output) console.log(output);

  return output || `exit ${result.code}`;
}

function installPlugin(catalog: string, plugin: CatalogEntry): PluginChange["install"] {
  const result = command(
    ["bun", "install", "--cwd", resolve(catalog, plugin.source), "--frozen-lockfile"],
    catalog,
  );

  const output = rawOutput(result);

  return result.code === 0 ? "ok" : { failed: output };
}

function updateEntry(
  catalog: string,
  plugin: CatalogEntry,
  installed: Map<string, InstalledEntry>,
): PluginChange["entry"] {
  const entry = installed.get(plugin.name);

  if (!entry) return "not-installed";

  if (entry.version === plugin.version) return "same-version";

  const result = command(
    ["claude", "plugin", "update", "--json", "--scope", "user", `${plugin.name}@${MARKETPLACE}`],
    catalog,
  );

  const output = rawOutput(result);

  if (result.code !== 0) return { failed: output };
  let response: { updateOutcome?: string; message?: string };

  try {
    response = JSON.parse(result.out);
  } catch {
    return { failed: `Invalid update JSON: ${output}` };
  }

  if (response?.updateOutcome === "updated") return "updated";

  if (response?.updateOutcome === "up_to_date") return "up-to-date";

  return { failed: response?.message ?? output };
}

function trackedChanges(catalog: string): string[] {
  return git(catalog, "diff", "HEAD", "--name-only", "-z").split("\0").filter(Boolean);
}

function syncOnce(repo: string, catalog: string, target: string): SyncReport {
  const old = git(catalog, "rev-parse", "HEAD");

  const report: SyncReport = {
    at: new Date().toISOString(),
    catalog: { kind: "current", at: old },
    plugins: [],
    notified: false,
  };

  const files = trackedChanges(catalog);

  if (files.length > 0) {
    report.catalog = { kind: "blocked", reason: "catalog has local changes", files };

    return report;
  }

  if (old === target) return report;
  const before = catalogEntries(repo, old);
  const after = catalogEntries(repo, target);

  const paths = git(repo, "diff", "--name-only", "--no-renames", "-z", old, target)
    .split("\0")
    .filter(Boolean);

  const installed = installedEntries();
  const checkout = command(["git", "checkout", "--detach", target], catalog);
  const output = rawOutput(checkout);

  if (checkout.code !== 0) {
    report.catalog = { kind: "blocked", reason: `checkout refused: ${output}`, files: [] };

    return report;
  }

  report.catalog = { kind: "moved", from: old, to: target };

  for (const change of changedPlugins(paths, before, after)) {
    const plugin = after.find((candidate) => candidate.name === change.name);

    const install =
      plugin && change.depsChanged && existsSync(resolve(catalog, plugin.source, "package.json"))
        ? installPlugin(catalog, plugin)
        : "skipped";

    const entry = plugin ? updateEntry(catalog, plugin, installed) : "not-installed";
    report.plugins.push({ name: change.name, from: change.from, to: change.to, install, entry });
  }

  return report;
}

function entryFailed(entry: PluginChange["entry"]): entry is { failed: string } {
  return (
    entry !== "updated" &&
    entry !== "up-to-date" &&
    entry !== "not-installed" &&
    entry !== "same-version"
  );
}

function failureCount(report: SyncReport): number {
  return report.plugins.filter(
    (plugin) =>
      (plugin.install !== "ok" && plugin.install !== "skipped") || entryFailed(plugin.entry),
  ).length;
}

export function notificationFor(
  report: SyncReport,
  catalog = "~/Work/claude-code-plugins.wt/catalog",
  head = "unknown",
): { title: string; body: string; urgency: "normal" | "critical" } | null {
  if (report.catalog.kind === "blocked") {
    const repair =
      report.catalog.reason === "catalog has local changes"
        ? `git -C ${catalog} restore .`
        : "remove it (the untracked file named by git), then retry; inspect other checkout errors in the journal";

    return {
      title: `Claude plugins stuck at ${head.slice(0, 7)}`,
      body: `${report.catalog.reason}:\n${report.catalog.files.map((file) => `  ${file}`).join("\n")}\nFix: ${repair}\nthen: systemctl --user start claude-plugin-catalog`,
      urgency: "critical",
    };
  }

  if (report.plugins.length === 0) return null;
  const failed = failureCount(report) > 0;
  const sha = report.catalog.kind === "moved" ? report.catalog.to : report.catalog.at;

  const lines = report.plugins
    .toSorted((a, b) => Number(a.from === a.to) - Number(b.from === b.to))
    .map((plugin) => {
      if (plugin.install !== "ok" && plugin.install !== "skipped")
        return `${plugin.name}: bun install --frozen-lockfile failed`;

      if (entryFailed(plugin.entry))
        return `${plugin.name}: plugin update failed: ${plugin.entry.failed}`;

      return plugin.from === plugin.to
        ? `${plugin.name} changed, same version ${plugin.to}`
        : `${plugin.name} ${plugin.from} → ${plugin.to}`;
    });

  lines.push("New sessions load it; restart open ones.");

  if (failed) lines.push("journalctl --user -u claude-plugin-catalog");

  return {
    title: failed
      ? `Claude plugins at dev ${sha.slice(0, 7)}, with failures`
      : `Claude plugins now at dev ${sha.slice(0, 7)}`,
    body: lines.join("\n"),
    urgency: failed ? "critical" : "normal",
  };
}

function sync(repo: string) {
  const catalog = findCatalog(repo).path;
  let target = git(repo, "rev-parse", "origin/dev");

  for (;;) {
    const report = syncOnce(repo, catalog, target);
    const notification = notificationFor(report, catalog, git(catalog, "rev-parse", "HEAD"));

    if (notification) {
      const result = command(
        [
          "notify-send",
          "-a",
          "Claude plugins",
          "-u",
          notification.urgency,
          notification.title,
          notification.body,
        ],
        catalog,
      );

      report.notified = result.code === 0;

      if (result.code !== 0) report.notifyError = rawOutput(result);
    }

    mkdirSync(dirname(statePath()), { recursive: true });
    appendFileSync(statePath(), `${JSON.stringify(report)}\n`);
    const next = git(repo, "rev-parse", "origin/dev");

    if (next === target) return;
    target = next;
  }
}

function setup(repo: string) {
  const trees = worktrees(repo);
  const locked = trees.filter((tree) => tree.lock === LOCK);

  if (locked.length > 1) throw new Error(`Multiple worktrees locked with reason: ${LOCK}`);
  const main = trees[0];

  if (!main) throw new Error("No main worktree");
  const catalog = locked[0]?.path ?? `${main.path}.wt/catalog`;

  if (locked[0] && !existsSync(catalog)) {
    git(repo, "worktree", "unlock", catalog);
    git(repo, "worktree", "prune");
  }

  if (!existsSync(catalog)) {
    git(repo, "worktree", "add", "--detach", catalog, git(repo, "rev-parse", "origin/dev"));
    git(repo, "worktree", "lock", "--reason", LOCK, catalog);
  }

  const tree = findCatalog(repo);

  if (tree.path !== catalog) throw new Error(`Catalog path mismatch: ${tree.path}`);

  if (trackedChanges(catalog).length > 0) throw new Error(`Catalog has local changes: ${catalog}`);

  for (const plugin of catalogEntries(repo, git(catalog, "rev-parse", "HEAD"))) {
    if (!existsSync(resolve(catalog, plugin.source, "package.json"))) continue;
    const result = installPlugin(catalog, plugin);

    if (result !== "ok" && result !== "skipped")
      throw new Error(`${plugin.name}: bun install failed: ${result.failed}`);
  }

  console.log(`Catalog: ${catalog} (locked, detached)`);
}

function status(repo: string) {
  const knownPath = configPath("known_marketplaces.json");

  const known: Record<string, { installLocation?: string }> = existsSync(knownPath)
    ? JSON.parse(readFileSync(knownPath, "utf8"))
    : {};

  console.log(
    `marketplace  ${MARKETPLACE} → ${known[MARKETPLACE]?.installLocation ?? "not registered"}`,
  );
  const catalog = findCatalog(repo).path;
  const head = git(catalog, "rev-parse", "HEAD");
  const target = git(repo, "rev-parse", "origin/dev");
  console.log(
    `catalog      ${catalog}: ${head.slice(0, 7)}, ${head === target ? "even with" : "differs from"} origin/dev (${target.slice(0, 7)}), ${trackedChanges(catalog).length > 0 ? "dirty" : "clean"}, locked`,
  );

  const enabled = command(
    ["systemctl", "--user", "is-enabled", "claude-plugin-catalog.path"],
    repo,
  );

  const active = command(["systemctl", "--user", "is-active", "claude-plugin-catalog.path"], repo);
  console.log(
    `units        claude-plugin-catalog.path ${enabled.out.trim() || enabled.err.trim()}, ${active.out.trim() || active.err.trim()}`,
  );

  const last = existsSync(statePath())
    ? readFileSync(statePath(), "utf8").trim().split("\n").at(-1)
    : undefined;

  if (last) {
    const report: SyncReport = JSON.parse(last);
    console.log(
      `last run     ${report.at} ${JSON.stringify(report.catalog)}, ${report.plugins.length} changed, ${failureCount(report)} failed`,
    );
  } else console.log("last run     none");
  const entries = catalogEntries(repo, head);
  console.log("\nplugin                         entry       catalog");

  for (const [name, entry] of installedEntries())
    console.log(
      `${name.padEnd(30)} ${entry.version.padEnd(11)} ${entries.find((plugin) => plugin.name === name)?.version ?? "not in catalog"}`,
    );
}

if (import.meta.main) {
  const action = process.argv[2];

  if (process.argv.length !== 3 || !["setup", "sync", "status"].includes(action ?? "")) {
    console.error("Usage: bun scripts/sessions/plugin-catalog.ts <setup|sync|status>");
    process.exitCode = 2;
  } else {
    try {
      const repo = repository();

      if (action === "setup") setup(repo);
      else if (action === "sync") sync(repo);
      else status(repo);
    } catch (error) {
      console.error(`plugin-catalog: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
