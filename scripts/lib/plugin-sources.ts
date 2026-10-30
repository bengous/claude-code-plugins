/**
 * Where a plugin can be read from: every worktree on disk, plus every ref that
 * carries commits on that plugin `dev` does not have.
 *
 * Version numbers never decide what is listed. The histories here were
 * rewritten, so a ref can sit at the same version as `dev` and still hold
 * three commits `dev` never saw.
 *
 * Run it to read the repo it lives in: `bun scripts/lib/plugin-sources.ts
 * [<plugin>]` prints the plugin rows, or one plugin's sources, as JSON.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { $ } from "bun";

const TRUNK = "dev";

const MANIFEST = ".claude-plugin/plugin.json";

/** A directory of the repo that plugins are read from: a checkout or a worktree. */
export type PluginDir = string & { readonly __brand: "PluginDir" };

/** A directory of a `PluginDir` that carries a plugin manifest. */
export type PluginName = string & { readonly __brand: "PluginName" };

interface Located {
  ref: string;
  version: string;
  /** Date of the last commit touching this plugin on this ref, `%cs`. */
  lastCommit: string;
  /** Commits on this plugin that `dev` does not have. */
  ahead: number;
}

export type Source =
  | (Located & { kind: "checkout"; dir: PluginDir })
  | (Located & { kind: "branch"; hasLocalBranch: boolean });

export interface PluginRow {
  name: PluginName;
  devVersion: string | null;
  installedVersion: string | null;
  outsideDev: boolean;
}

export interface Checkout {
  dir: PluginDir;
  head: string;
  /** The porcelain's `branch` field; null on a detached HEAD, which has no ref to name. */
  branch: string | null;
}

export interface Worktrees {
  /** The main working tree, the only one whose path names the `.wt/` sibling. */
  main: PluginDir;
  checkouts: Checkout[];
}

/**
 * The one constructor of `PluginDir`. Null when the path is not a directory,
 * which is how a worktree git still lists but the disk no longer holds, or a
 * plugin absent from a checkout, leaves the source list.
 */
export function pluginDirAt(path: string): PluginDir | null {
  const absolute = resolve(path);

  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return null;

  // SAFETY: the brand states the path is an existing directory, checked above.
  return absolute as PluginDir;
}

/** The one constructor of `PluginName`: a directory of `root` with a manifest. */
export function pluginNameIn(root: PluginDir, name: string): PluginName | null {
  if (!existsSync(join(root, name, MANIFEST))) return null;

  // SAFETY: the brand states the directory carries a plugin manifest, checked above.
  return name as PluginName;
}

export function pluginNamesIn(root: PluginDir): PluginName[] {
  return readdirSync(root)
    .toSorted()
    .flatMap((entry) => {
      const name = pluginNameIn(root, entry);

      return name === null ? [] : [name];
    });
}

/** The path `tp` materializes a ref at, the convention `git-wt` already follows. */
export function worktreePathFor(main: PluginDir, ref: string): string {
  return join(`${main}.wt`, ref);
}

async function git(root: PluginDir, args: string[]): Promise<string> {
  const result = await $`git -C ${root} ${args}`.nothrow().quiet();

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString();
}

/** Git's own output, for the calls whose failure is an answer: no such path at that ref. */
async function gitOrNull(root: PluginDir, args: string[]): Promise<string | null> {
  const result = await $`git -C ${root} ${args}`.nothrow().quiet();

  return result.exitCode === 0 ? result.stdout.toString() : null;
}

function lines(output: string): string[] {
  return output.split("\n").filter((line) => line !== "");
}

/**
 * A plugin's manifest. `name` is what the marketplace and the install state
 * index it under, and it is not always the directory name: `orchestration/`
 * declares `claude-orchestration`.
 */
export interface Manifest {
  name?: string;
  version?: string;
}

function manifestOf(text: string | null): Manifest | null {
  if (text === null) return null;

  const manifest: Manifest = JSON.parse(text);

  return manifest;
}

/**
 * Every working tree the porcelain lists, detached ones included: a ref this
 * script materialized for a remote branch has no local branch, so a reader that
 * waits for a `branch` line never sees it again, and the next launch runs
 * `worktree add` on a path that already exists.
 *
 * The `branch` field is the only tie between a ref and a worktree; the path
 * lies, `.wt/feature/vellum-grill` holds `squash/vellum-grill`.
 */
export async function readWorktrees(root: PluginDir): Promise<Worktrees> {
  const checkouts: Checkout[] = [];
  let dir: PluginDir | null = null;
  let head = "";
  let branch: string | null = null;

  const flush = () => {
    if (dir !== null && head !== "") checkouts.push({ dir, head, branch });

    dir = null;
    head = "";
    branch = null;
  };

  for (const line of lines(await git(root, ["worktree", "list", "--porcelain"]))) {
    if (line.startsWith("worktree ")) {
      flush();
      dir = pluginDirAt(line.slice("worktree ".length));
    } else if (line.startsWith("HEAD ")) {
      head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length);
    }
  }

  flush();

  const main = checkouts[0]?.dir;

  if (main === undefined) throw new Error(`no working tree listed for ${root}`);

  return { main, checkouts };
}

interface Candidate {
  ref: string;
  head: string;
  dir: PluginDir | null;
  hasLocalBranch: boolean;
}

const REF_FORMAT = "%(refname)%09%(objectname)";

/**
 * The ref space must be named. Left to itself, `--no-merged dev` also brings
 * back `refs/original/refs/heads/main` and a `backup/…` tag, both dozens of
 * commits ahead of anything a branch holds.
 */
async function refsOutsideTrunk(root: PluginDir): Promise<Candidate[]> {
  const listed = await git(root, [
    "for-each-ref",
    "--no-merged",
    TRUNK,
    `--format=${REF_FORMAT}`,
    "refs/heads",
    "refs/remotes",
  ]);

  return lines(listed).flatMap((line) => {
    const [refname = "", head = ""] = line.split("\t");
    const local = refname.startsWith("refs/heads/");
    const ref = local ? refname.slice("refs/heads/".length) : refname.slice("refs/remotes/".length);

    return ref === "" ? [] : [{ ref, head, dir: null, hasLocalBranch: local }];
  });
}

/**
 * Every worktree stays, whatever commit it sits on: two of them can share a
 * commit and still hold two different working trees, and the uncommitted edit
 * under test lives in one of them. Only refs collapse — two refs on one commit
 * are the same code, and a commit a worktree already has out is that worktree.
 * `dev` is exempt: it is the landmark the other lines are read against.
 */
function dedupe(candidates: Candidate[]): Candidate[] {
  const checkouts = candidates.filter((candidate) => candidate.dir !== null);
  const onDisk = new Set(checkouts.map((candidate) => candidate.head));
  const kept = new Map<string, Candidate>();

  for (const candidate of candidates) {
    if (candidate.dir !== null) continue;

    if (candidate.ref !== TRUNK && onDisk.has(candidate.head)) continue;

    const seen = kept.get(candidate.head);

    if (seen === undefined || rank(candidate) < rank(seen)) kept.set(candidate.head, candidate);
  }

  return [...checkouts, ...kept.values()];
}

function rank(candidate: Candidate): number {
  if (candidate.ref === TRUNK) return 0;

  return candidate.hasLocalBranch ? 1 : 2;
}

async function readSource(
  root: PluginDir,
  plugin: PluginName,
  candidate: Candidate,
): Promise<Source | null> {
  const ahead = lines(
    await git(root, ["log", "--format=%cs", `${TRUNK}..${candidate.ref}`, "--", plugin]),
  );

  if (candidate.dir === null && ahead.length === 0 && candidate.ref !== TRUNK) return null;

  const version = manifestOf(
    candidate.dir === null
      ? await gitOrNull(root, ["show", `${candidate.ref}:${plugin}/${MANIFEST}`])
      : await readManifest(candidate.dir, plugin),
  )?.version;

  if (version === undefined) return null;

  const located: Located = {
    ref: candidate.ref,
    version,
    lastCommit:
      ahead[0] ??
      (await git(root, ["log", "-1", "--format=%cs", candidate.ref, "--", plugin])).trim(),
    ahead: ahead.length,
  };

  return candidate.dir === null
    ? { ...located, kind: "branch", hasLocalBranch: candidate.hasLocalBranch }
    : { ...located, kind: "checkout", dir: candidate.dir };
}

async function readManifest(dir: PluginDir, plugin: PluginName): Promise<string | null> {
  const file = Bun.file(join(dir, plugin, MANIFEST));

  return (await file.exists()) ? file.text() : null;
}

function byRecency(left: Source, right: Source): number {
  if (left.lastCommit !== right.lastCommit) return left.lastCommit < right.lastCommit ? 1 : -1;

  const order = sortRank(left) - sortRank(right);

  return order === 0 ? left.ref.localeCompare(right.ref) : order;
}

function sortRank(source: Source): number {
  if (source.ref === TRUNK) return 0;

  return source.kind === "checkout" ? 1 : 2;
}

/**
 * Every source of one plugin: the worktrees on disk, `dev` as a landmark, and
 * the refs carrying commits on that plugin `dev` does not have.
 */
export async function readSources(root: PluginDir, plugin: PluginName): Promise<Source[]> {
  const [worktrees, scanned, trunkHead] = await Promise.all([
    readWorktrees(root),
    refsOutsideTrunk(root),
    git(root, ["rev-parse", TRUNK]),
  ]);

  const candidates = new Map<string, Candidate>();
  // A detached worktree names no ref, so it is tied to the ref whose tip it
  // holds — which is how the one this script creates for a remote branch is
  // found again instead of being created twice.
  const detached = new Map<string, Checkout>();

  // One candidate per ref, the worktrees first: a ref a worktree has out is
  // read from that worktree, and never listed a second time as a bare ref.
  for (const checkout of worktrees.checkouts) {
    if (checkout.branch === null) {
      detached.set(checkout.head, checkout);
    } else {
      candidates.set(checkout.branch, {
        ref: checkout.branch,
        head: checkout.head,
        dir: checkout.dir,
        hasLocalBranch: true,
      });
    }
  }

  if (!candidates.has(TRUNK)) {
    const head = trunkHead.trim();

    candidates.set(TRUNK, {
      ref: TRUNK,
      head,
      dir: detached.get(head)?.dir ?? null,
      hasLocalBranch: true,
    });
  }

  for (const candidate of scanned) {
    if (candidates.has(candidate.ref)) continue;

    const held = detached.get(candidate.head);

    candidates.set(candidate.ref, held === undefined ? candidate : { ...candidate, dir: held.dir });
  }

  const sources = await Promise.all(
    dedupe([...candidates.values()]).map((candidate) => readSource(root, plugin, candidate)),
  );

  return sources.flatMap((source) => (source === null ? [] : [source])).toSorted(byRecency);
}

/**
 * The top-level directory of every path touched outside `dev`, in one pass.
 * It answers "has this plugin work elsewhere", never "how much": a count per
 * plugin is a scan per plugin.
 */
async function touchedOutsideTrunk(root: PluginDir): Promise<Set<string>> {
  const listed = await git(root, [
    "log",
    "--format=",
    "--name-only",
    "--glob=refs/heads",
    "--glob=refs/remotes",
    `^${TRUNK}`,
  ]);

  return new Set(lines(listed).map((path) => path.split("/")[0] ?? path));
}

/**
 * The versions Claude Code loads without `--plugin-dir`, read from the user
 * scope of its install state.
 */
export async function installedVersions(): Promise<Map<string, string>> {
  const config = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  const file = Bun.file(join(config, "plugins", "installed_plugins.json"));

  if (!(await file.exists())) return new Map();

  const state: { plugins?: Record<string, { scope?: string; version?: string }[]> } =
    await file.json();

  const versions = new Map<string, string>();

  for (const [key, entries] of Object.entries(state.plugins ?? {})) {
    const user = entries.find((entry) => entry.scope === "user");
    const name = key.split("@")[0];

    if (user?.version === undefined || name === undefined) continue;

    versions.set(name, user.version);
  }

  return versions;
}

/**
 * Claude Code installs a plugin's dependencies at its cache; under
 * `--plugin-dir` nothing does. Null once installed or when the plugin has
 * none; else why the install failed.
 */
export async function installDependencies(pluginDir: string): Promise<string | null> {
  if (!existsSync(join(pluginDir, "package.json"))) return null;

  const installed = await $`bun install --cwd ${pluginDir} --frozen-lockfile`.nothrow().quiet();

  return installed.exitCode === 0
    ? null
    : `bun install in ${pluginDir}\n${installed.stderr.toString().trim()}`;
}

/** One row per plugin of `root`, for the first screen and for `--list`. */
export async function readPlugins(root: PluginDir): Promise<PluginRow[]> {
  const names = pluginNamesIn(root);

  const [installed, touched, manifests] = await Promise.all([
    installedVersions(),
    touchedOutsideTrunk(root),
    Promise.all(
      names.map(async (name) =>
        manifestOf(await gitOrNull(root, ["show", `${TRUNK}:${name}/${MANIFEST}`])),
      ),
    ),
  ]);

  return names.map((name, index) => {
    const manifest = manifests[index];

    return {
      name,
      devVersion: manifest?.version ?? null,
      // The install state is indexed by the declared name, not by the directory.
      installedVersion: installed.get(manifest?.name ?? name) ?? null,
      outsideDev: touched.has(name),
    };
  });
}

if (import.meta.main) {
  const root = pluginDirAt(join(import.meta.dir, "..", ".."));

  if (root === null) throw new Error("plugin-sources: no directory above scripts/lib");

  const [named] = process.argv.slice(2);

  if (named === undefined) {
    console.log(JSON.stringify(await readPlugins(root), null, 2));
  } else {
    const plugin = pluginNameIn(root, named);

    if (plugin === null) throw new Error(`plugin-sources: no plugin "${named}" in ${root}`);

    console.log(JSON.stringify(await readSources(root, plugin), null, 2));
  }
}
