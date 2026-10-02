#!/usr/bin/env bun

/**
 * A debug Claude Code session on plugins read from source, with no `cd`.
 *
 *   try-plugin.ts                        pick the plugin, then the source
 *   try-plugin.ts <plugin>... [-- args]  the scripted path, no picker
 *   try-plugin.ts --list                 one plugin name per line
 *
 * Why each launch flag is there: docs/plugin-testing/sessions.md, "Launch a test session".
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { $ } from "bun";

import {
  type Manifest,
  type PluginDir,
  type PluginName,
  type PluginRow,
  type Source,
  installedVersions,
  pluginDirAt,
  pluginNameIn,
  pluginNamesIn,
  readPlugins,
  readSources,
  readWorktrees,
  worktreePathFor,
} from "./lib/plugin-sources.ts";

const USAGE = "usage: try-plugin.ts [<plugin>...] [-- <claude args>] | --list";

const DASH = "—";

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

export function table(rows: string[][]): string[] {
  const widths = rows.reduce<number[]>(
    (widest, row) =>
      row.map((cell, column) => Math.max(widest[column] ?? 0, Bun.stringWidth(cell))),
    [],
  );

  return rows.map((row) =>
    row
      .map((cell, column) => cell + " ".repeat((widths[column] ?? 0) - Bun.stringWidth(cell)))
      .join("  ")
      .trimEnd(),
  );
}

/** The plugins with work outside `dev` first: that column is what the screen is for. */
export function pluginTable(rows: PluginRow[]): string[] {
  const ordered = rows.toSorted((left, right) => {
    if (left.outsideDev !== right.outsideDev) return left.outsideDev ? -1 : 1;

    return left.name.localeCompare(right.name);
  });

  return table([
    ["PLUGIN", "INSTALLED", "DEV", "OUTSIDE DEV"],
    ...ordered.map((row) => [
      row.name,
      row.installedVersion ?? DASH,
      row.devVersion ?? DASH,
      row.outsideDev ? "yes" : "",
    ]),
  ]);
}

export function whereOf(source: Source, main: PluginDir): string {
  if (source.kind === "branch") return "no worktree";

  if (source.dir === main) return "main checkout";

  const inside = source.dir.startsWith(main) ? source.dir.slice(main.length) : source.dir;

  return `worktree ${inside.startsWith("/") ? inside.slice(1) : inside}`;
}

export function sourceTable(sources: Source[], main: PluginDir): string[] {
  return table([
    ["SOURCE", "VERSION", "WHERE", "LAST COMMIT", "AHEAD"],
    ...sources.map((source) => [
      source.ref,
      source.version,
      whereOf(source, main),
      source.lastCommit,
      source.ahead === 0 ? DASH : String(source.ahead),
    ]),
  ]);
}

/**
 * fzf reads and writes `/dev/tty` itself, so its screen never reaches the
 * captured stdout. `--accept-nth=1` hands back the first column alone: the
 * padded line is never parsed again.
 */
async function pick(lines: string[], prompt: string): Promise<string> {
  if (Bun.which("fzf") === null) fail("tp: fzf is not on PATH", 1);

  const fzf = Bun.spawn(
    [
      "fzf",
      "--layout=reverse",
      "--height=~60%",
      "--header-lines=1",
      "--nth=1",
      "--accept-nth=1",
      `--prompt=${prompt}`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );

  fzf.stdin.write(lines.join("\n"));
  await fzf.stdin.end();

  const chosen = (await new Response(fzf.stdout).text()).trim();
  const code = await fzf.exited;

  if (code === 130) process.exit(130);

  if (code === 1) fail("tp: nothing matched", 1);

  if (code !== 0) fail(`tp: fzf exited ${code}`, 1);

  return chosen;
}

async function pickPlugin(root: PluginDir): Promise<PluginName> {
  const chosen = await pick(pluginTable(await readPlugins(root)), "Select plugin: ");
  const plugin = pluginNameIn(root, chosen);

  if (plugin === null) fail(`tp: no plugin "${chosen}" in ${root}`, 1);

  return plugin;
}

/**
 * The commit-ish is always passed. `git worktree add <path>` alone branches off
 * `HEAD`, names the branch after the last segment of the path and exits 0: the
 * session would read `dev`'s code believing it read the ref.
 */
async function materialize(main: PluginDir, ref: string, hasLocalBranch: boolean) {
  const path = worktreePathFor(main, ref);

  console.log(`creating worktree: ${path}`);

  const added = await $`git -C ${main} worktree add ${path} ${ref}`.nothrow().quiet();
  const dir = added.exitCode === 0 ? pluginDirAt(path) : null;

  // Git's exit code is 0, 128 or 255 depending on the case; its output is the message.
  if (dir === null) fail(`${added.stdout.toString()}${added.stderr.toString()}`.trim(), 1);

  if (!hasLocalBranch) console.log("warning: detached HEAD, no local branch for this ref");

  console.log(`created ${ref}`);

  return dir;
}

/** The directory the chosen source reads the plugin from, created if it is a bare ref. */
async function chooseSource(root: PluginDir, plugin: PluginName): Promise<PluginDir> {
  const { main } = await readWorktrees(root);
  const sources = await readSources(root, plugin);
  const chosen = await pick(sourceTable(sources, main), "Select source: ");
  const source = sources.find((candidate) => candidate.ref === chosen);

  if (source === undefined) fail(`tp: no source "${chosen}" for ${plugin}`, 1);

  return source.kind === "checkout"
    ? source.dir
    : materialize(main, source.ref, source.hasLocalBranch);
}

export function claudeArgv(pluginDirs: string[], claudeArgs: string[]): string[] {
  return [
    "claude",
    "--debug",
    "--permission-mode",
    "default",
    ...pluginDirs.flatMap((dir) => ["--plugin-dir", dir]),
    ...claudeArgs,
  ];
}

/**
 * A process a plugin spawned detached outlives the session and keeps the code
 * it started with: a session that finds it again runs old code beside the new
 * hooks module. Nothing here kills them; they are named, and that is all.
 */
async function survivors(checkout: PluginDir): Promise<string[]> {
  const listed = await $`pgrep -af ${`${checkout}/`}`.nothrow().quiet().text();

  const pids = listed.split("\n").flatMap((line) => {
    const [pid = "", ...rest] = line.split(" ");
    const command = rest.join(" ");

    if (pid === "" || command.startsWith("claude ") || command.includes("try-plugin")) return [];

    return [pid];
  });

  if (pids.length === 0) return [];

  const reported = await $`ps -o pid=,lstart=,args= -p ${pids.join(",")}`.nothrow().quiet().text();

  return reported
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [pid = "", ...fields] = line.trim().split(/\s+/u);

      return `  ${pid}  started ${fields.slice(0, 5).join(" ")}  ${fields.slice(5).join(" ").slice(0, 120)}`;
    });
}

async function header(checkout: PluginDir, plugins: PluginName[]): Promise<string[]> {
  const commit = (await $`git -C ${checkout} log -1 --format=%h\ %s`.quiet().text()).trim();
  const status = (await $`git -C ${checkout} status --porcelain`.quiet().text()).trim();

  const installed = await installedVersions();

  const loaded = await Promise.all(
    plugins.map(async (plugin) => {
      const manifest: Manifest = await Bun.file(
        join(checkout, plugin, ".claude-plugin", "plugin.json"),
      ).json();

      // The install state is indexed by the declared name, not by the directory.
      const override = installed.get(manifest.name ?? plugin);

      const suffix = override === undefined ? "" : `  (installed ${override} will be overridden)`;

      return `loaded:       ${plugin} ${manifest.version ?? DASH}${suffix}`;
    }),
  );

  return [
    `plugins from: ${checkout}`,
    `commit:       ${commit}${status === "" ? "" : " + uncommitted changes"}`,
    ...loaded,
    "debug log:    ~/.claude/debug/latest",
    ...(await survivors(checkout)).flatMap((line, index) =>
      index === 0
        ? ["still alive from an earlier session, on the code of their start time:", line]
        : [line],
    ),
  ];
}

/**
 * Claude Code installs a plugin's dependencies at its cache; under
 * `--plugin-dir` nothing does.
 */
async function install(pluginDir: string): Promise<void> {
  if (!existsSync(join(pluginDir, "package.json"))) return;

  const installed = await $`bun install --cwd ${pluginDir} --frozen-lockfile`.nothrow().quiet();

  if (installed.exitCode !== 0) {
    fail(`tp: bun install in ${pluginDir}\n${installed.stderr.toString().trim()}`, 1);
  }
}

/**
 * Terminal: `execve` replaces this process, so nothing after it runs. Its
 * `PluginDir` is the state the launch depends on: a ref with no worktree has
 * no directory to hand it, and cannot reach here.
 */
async function launch(
  checkout: PluginDir,
  plugins: PluginName[],
  claudeArgs: string[],
): Promise<void> {
  const pluginDirs = plugins.map((plugin) => join(checkout, plugin));

  for (const dir of pluginDirs) await install(dir);

  console.log((await header(checkout, plugins)).join("\n"));

  // `claude` on PATH is the binary, never the owner's shell function, which
  // injects --dangerously-skip-permissions into every plain launch.
  const claude = Bun.which("claude");

  if (claude === null) fail("tp: claude is not on PATH", 1);

  const { execve } = process;

  if (execve === undefined) fail("tp: this build of Bun has no process.execve", 1);

  execve(claude, claudeArgv(pluginDirs, claudeArgs));
}

/** The working tree holding `path`, and the repository it belongs to. */
async function checkoutAt(path: string) {
  const read =
    await $`git -C ${path} rev-parse --path-format=absolute --show-toplevel --git-common-dir`
      .nothrow()
      .quiet();

  if (read.exitCode !== 0) return null;

  const [top = "", repository = ""] = read.stdout.toString().split("\n");
  const dir = pluginDirAt(top);

  return dir === null ? null : { dir, repository };
}

/**
 * The checkout the script lives in, so `tp` works from anywhere, `/tmp`
 * included. A shell sitting in another worktree of that same repository keeps
 * winning, as it did when the launcher was bash; a shell in an unrelated repo
 * does not.
 */
async function resolveRoot(): Promise<PluginDir> {
  const own = pluginDirAt(join(import.meta.dir, ".."));
  const mine = own === null ? null : await checkoutAt(own);

  if (mine === null) fail(`tp: no git repository at ${join(import.meta.dir, "..")}\n${USAGE}`, 2);

  const here = await checkoutAt(process.cwd());

  return here !== null && here.repository === mine.repository ? here.dir : mine.dir;
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--list") {
    console.log(pluginNamesIn(await resolveRoot()).join("\n"));
    process.exit(0);
  }

  const separator = args.indexOf("--");
  const named = separator === -1 ? args : args.slice(0, separator);
  const claudeArgs = separator === -1 ? [] : args.slice(separator + 1);
  const root = await resolveRoot();

  const plugins = named.map(
    (name) =>
      pluginNameIn(root, name) ?? fail(`tp: no plugin "${name}" in ${root}\ntry: tp --list`, 1),
  );

  if (plugins.length > 1 || (plugins.length === 1 && separator !== -1)) {
    await launch(root, plugins, claudeArgs);
  } else {
    const plugin = plugins[0] ?? (await pickPlugin(root));

    await launch(await chooseSource(root, plugin), [plugin], claudeArgs);
  }
}
