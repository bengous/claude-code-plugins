#!/usr/bin/env bun

/**
 * The release guard: a marketplace plugin whose directory changed between two
 * commits while its `plugin.json` `version` did not. Claude Code keys its
 * plugin cache on that version, so an installed copy would never see the change.
 *
 *   bun ./scripts/check-plugin-bumps.ts <base-ref> <head-ref>
 *   bun ./scripts/check-plugin-bumps.ts --pre-push < <git's pushed-ref lines>
 *
 * `--pre-push` checks each line whose remote ref is `refs/heads/main`, from its
 * remote oid to its local oid, with no fetch; a push to any other ref passes.
 * Exit 1 names each plugin on a line of its own. The pre-push hook runs it,
 * outside `EXPECTED_COMMANDS`: `.claude/rules/hook-ladder.md` says why.
 */

import { type PluginDir, pluginDirAt } from "./lib/plugin-sources.ts";

const CATALOG = ".claude-plugin/marketplace.json";

const MANIFEST = ".claude-plugin/plugin.json";

// The local ref is the source as typed, `HEAD@{1 day ago}` included: only the
// last three fields are free of spaces.
const PUSHED_REF_LINE = /^.+ ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+) ([0-9a-f]{40}|[0-9a-f]{64})$/u;

const ZERO_OID = /^0+$/u;

/** A full commit id git resolved in the repository it was read from. */
export type CommitId = string & { readonly __brand: "CommitId" };

/** A full ref, as a pushed-ref line names it: `refs/heads/main`. */
export type RefName = string & { readonly __brand: "RefName" };

/** A marketplace entry's `name`, the one installs and updates know a plugin by. */
export type MarketplaceName = string & { readonly __brand: "MarketplaceName" };

/** A marketplace entry's `source`, `./x/` read as `x`: the plugin's directory. */
export type SourceDir = string & { readonly __brand: "SourceDir" };

/** A `plugin.json` `version`, non-empty. */
export type Version = string & { readonly __brand: "Version" };

/** One line git hands a pre-push hook; `null` stands for git's zero oid. */
export interface PushedRef {
  readonly local: CommitId | null;
  readonly remoteRef: RefName;
  readonly remote: CommitId | null;
}

export interface Unbumped {
  readonly name: MarketplaceName;
  readonly source: SourceDir;
  readonly version: Version;
}

/** What this guard reads of the marketplace file. */
interface CatalogFile {
  readonly plugins: readonly { readonly name: string; readonly source: string }[];
}

/** What this guard reads of a plugin manifest. */
interface ManifestFile {
  readonly version?: string;
}

interface CatalogEntry {
  readonly name: MarketplaceName;
  readonly source: SourceDir;
}

interface Release {
  readonly base: CommitId;
  readonly head: CommitId;
}

function spawnGit(repo: PluginDir, args: readonly string[]) {
  return Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
}

function git(repo: PluginDir, args: readonly string[]): string {
  const result = spawnGit(repo, args);

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString();
}

/** Git's own output, for the calls whose failure is an answer: no such commit, no such path. */
function gitOrNull(repo: PluginDir, args: readonly string[]): string | null {
  const result = spawnGit(repo, args);

  return result.exitCode === 0 ? result.stdout.toString() : null;
}

/** The one constructor of `CommitId`. */
export function commitAt(repo: PluginDir, ref: string): CommitId {
  const oid = gitOrNull(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ])?.trim();

  if (oid === undefined) throw new Error(`no commit ${JSON.stringify(ref)} in ${repo}`);

  // SAFETY: the brand states git resolved the ref to a commit the repository holds, checked above.
  return oid as CommitId;
}

/** The one constructor of `RefName`. */
function refNameOf(text: string): RefName {
  if (!/^refs\/\S+$/u.test(text)) throw new Error(`not a full ref: ${JSON.stringify(text)}`);

  // SAFETY: the brand states a full ref, `refs/` then no whitespace, checked above.
  return text as RefName;
}

/** The one constructor of `MarketplaceName`. */
function marketplaceNameOf(text: string, where: string): MarketplaceName {
  if (text === "") throw new Error(`${where}: a plugin entry has an empty name`);

  // SAFETY: the brand states a non-empty entry name, checked above.
  return text as MarketplaceName;
}

/** The one constructor of `SourceDir`. */
function sourceDirOf(text: string, where: string): SourceDir {
  const dir = text.startsWith("./") ? text.slice("./".length).replace(/\/$/u, "") : "";

  if (dir === "" || dir.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${where}: source ${JSON.stringify(text)} is not a "./<directory>" path`);
  }

  // SAFETY: the brand states a directory below the repository root, `./` and a trailing `/` dropped, checked above.
  return dir as SourceDir;
}

/** The one constructor of `Version`. */
function versionOf(text: string | undefined, where: string): Version {
  if (text === undefined || text === "") {
    throw new Error(`${where}: version ${JSON.stringify(text)} is missing or empty`);
  }

  // SAFETY: the brand states a non-empty version, checked above.
  return text as Version;
}

const MAIN = refNameOf("refs/heads/main");

function oidAt(repo: PluginDir, oid: string, missing: string): CommitId | null {
  if (ZERO_OID.test(oid)) return null;

  try {
    return commitAt(repo, oid);
  } catch (error) {
    throw new Error(missing, { cause: error });
  }
}

/**
 * The lines to `refs/heads/main` among those git hands a pre-push hook. A line
 * to another ref is dropped before its oids are read: a forced push to a branch
 * whose remote tip was never fetched carries an oid this repository lacks.
 */
export function parsePushedRefs(repo: PluginDir, lines: string): readonly PushedRef[] {
  return lines
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const [, local, remoteRef, remote] = PUSHED_REF_LINE.exec(line) ?? [];

      if (local === undefined || remoteRef === undefined || remote === undefined) {
        throw new Error(`not a line git hands a pre-push hook: ${JSON.stringify(line)}`);
      }

      const ref = refNameOf(remoteRef);

      if (ref !== MAIN) return [];

      return [
        {
          local: oidAt(repo, local, `the pushed commit ${local} is not in ${repo}`),
          remoteRef: ref,
          remote: oidAt(
            repo,
            remote,
            `${ref} is at ${remote} on the remote, a commit this repository does not have: fetch origin first`,
          ),
        },
      ];
    });
}

/** A file's JSON at a commit, or null when the commit does not hold it. */
function jsonAt<Content>(repo: PluginDir, commit: CommitId, path: string): Content | null {
  const text = gitOrNull(repo, ["show", `${commit}:${path}`]);

  if (text === null) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} at ${commit}: not JSON`, { cause: error });
  }
}

function catalogAt(repo: PluginDir, commit: CommitId): readonly CatalogEntry[] {
  const where = `${CATALOG} at ${commit}`;
  const catalog = jsonAt<CatalogFile>(repo, commit, CATALOG);

  if (!Array.isArray(catalog?.plugins)) throw new Error(`${where}: missing, or no plugins array`);

  return catalog.plugins.map((entry) => ({
    name: marketplaceNameOf(entry.name, where),
    source: sourceDirOf(entry.source, where),
  }));
}

function versionAt(repo: PluginDir, commit: CommitId, source: SourceDir): Version | null {
  const path = `${source}/${MANIFEST}`;
  const manifest = jsonAt<ManifestFile>(repo, commit, path);

  return manifest === null ? null : versionOf(manifest.version, `${path} at ${commit}`);
}

/**
 * Each plugin of `head`'s catalog whose directory differs between `base` and
 * `head` while its `plugin.json` version is the same on both.
 */
export function unbumped(repo: PluginDir, base: CommitId, head: CommitId): readonly Unbumped[] {
  const changed = git(repo, ["diff", "--name-only", "--no-renames", "-z", base, head])
    .split("\0")
    .filter((path) => path !== "");

  return catalogAt(repo, head).flatMap(({ name, source }) => {
    if (!changed.some((path) => path.startsWith(`${source}/`))) return [];

    const released = versionAt(repo, base, source);

    if (released === null) return [];

    const current = versionAt(repo, head, source);

    if (current === null) throw new Error(`${name}: no ${source}/${MANIFEST} at ${head}`);

    return released === current ? [{ name, source, version: current }] : [];
  });
}

/** What a push releases: each line to main but a deletion, which pushes no code. */
function releasesIn(pushed: readonly PushedRef[]): readonly Release[] {
  return pushed.flatMap(({ local, remoteRef, remote }) => {
    if (local === null) return [];

    if (remote === null) {
      throw new Error(
        `${remoteRef} does not exist on the remote (null remote oid), so no release to compare with`,
      );
    }

    return [{ base: remote, head: local }];
  });
}

function repositoryAt(cwd: string): PluginDir {
  const result = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const root = result.exitCode === 0 ? pluginDirAt(result.stdout.toString().trim()) : null;

  if (root === null) throw new Error(`not in a git working tree: ${cwd}`);

  return root;
}

async function releasesAsked(
  repo: PluginDir,
  args: readonly string[],
): Promise<readonly Release[] | null> {
  const [first, second] = args;

  if (args.length === 1 && first === "--pre-push") {
    return releasesIn(parsePushedRefs(repo, await Bun.stdin.text()));
  }

  if (args.length === 2 && first !== undefined && second !== undefined) {
    return [{ base: commitAt(repo, first), head: commitAt(repo, second) }];
  }

  return null;
}

if (import.meta.main) {
  try {
    const repo = repositoryAt(process.cwd());
    const releases = await releasesAsked(repo, process.argv.slice(2));

    if (releases === null) {
      console.error(
        "Usage: bun ./scripts/check-plugin-bumps.ts <base-ref> <head-ref> | --pre-push",
      );
      process.exitCode = 2;
    } else {
      const found = releases.flatMap(({ base, head }) =>
        unbumped(repo, base, head).map(
          ({ name, source, version }) =>
            `${name}: ./${source} changed since ${base.slice(0, 7)}, version still ${version}`,
        ),
      );

      if (found.length > 0) {
        console.error(
          [...found, "Bump each version in its plugin.json before main moves."].join("\n"),
        );
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(`check-plugin-bumps: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
