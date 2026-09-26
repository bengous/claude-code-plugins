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

/** A pushed-ref line that moves main; a null `remote` is git's zero oid, a remote without main. */
export interface PushedRef {
  readonly local: CommitId;
  readonly remoteRef: RefName;
  readonly remote: CommitId | null;
}

export interface Unbumped {
  readonly name: MarketplaceName;
  readonly source: SourceDir;
  readonly version: Version;
}

interface CatalogFile {
  readonly plugins: readonly { readonly name?: string; readonly source: string }[];
}

interface ManifestFile {
  readonly version?: string;
}

export interface CatalogEntry {
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

export function commitAt(repo: PluginDir, ref: string): CommitId {
  const result = spawnGit(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);

  if (result.exitCode !== 0) throw new Error(`no commit ${JSON.stringify(ref)} in ${repo}`);

  // SAFETY: the brand states git resolved the ref to a commit the repository holds, checked above.
  return result.stdout.toString().trim() as CommitId;
}

function refNameOf(text: string): RefName {
  if (!/^refs\/\S+$/u.test(text)) throw new Error(`not a full ref: ${JSON.stringify(text)}`);

  // SAFETY: the brand states a full ref, `refs/` then no whitespace, checked above.
  return text as RefName;
}

function marketplaceNameOf(text: string | undefined, where: string): MarketplaceName {
  if (text === undefined || text === "") throw new Error(`${where} has no name`);

  // SAFETY: the brand states a non-empty entry name, checked above.
  return text as MarketplaceName;
}

export function sourceDirOf(text: string, where: string): SourceDir {
  const dir = text.startsWith("./") ? text.slice("./".length).replace(/\/$/u, "") : "";

  if (dir === "" || dir.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${where}: source ${JSON.stringify(text)} is not a "./<directory>" path`);
  }

  // SAFETY: the brand states a directory below the repository root, `./` and a trailing `/` dropped, checked above.
  return dir as SourceDir;
}

function versionOf(text: string | undefined, where: string): Version {
  if (text === undefined || text === "") {
    throw new Error(`${where}: version ${JSON.stringify(text)} is missing or empty`);
  }

  // SAFETY: the brand states a non-empty version, checked above.
  return text as Version;
}

const MAIN = refNameOf("refs/heads/main");

function pushedCommit(repo: PluginDir, oid: string, missing: string): CommitId {
  try {
    return commitAt(repo, oid);
  } catch (error) {
    throw new Error(missing, { cause: error });
  }
}

/**
 * The lines that move `refs/heads/main` among those git hands a pre-push hook.
 * Any other line, a deletion of main included, is dropped before its oids are
 * read: its remote oid can be a commit this repository never fetched.
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

      if (ref !== MAIN || ZERO_OID.test(local)) return [];

      return [
        {
          local: pushedCommit(repo, local, `the pushed commit ${local} is not in ${repo}`),
          remoteRef: ref,
          remote: ZERO_OID.test(remote)
            ? null
            : pushedCommit(
                repo,
                remote,
                `${ref} is at ${remote} on the remote, a commit this repository does not have: fetch origin first`,
              ),
        },
      ];
    });
}

function jsonAt<Content>(repo: PluginDir, commit: CommitId, path: string): Content {
  const text = git(repo, ["show", `${commit}:${path}`]);

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} at ${commit}: not JSON`, { cause: error });
  }
}

export function catalogAt(repo: PluginDir, commit: CommitId): readonly CatalogEntry[] {
  const where = `${CATALOG} at ${commit}`;
  const catalog = jsonAt<CatalogFile>(repo, commit, CATALOG);

  if (!Array.isArray(catalog.plugins)) throw new Error(`${where}: no plugins array`);

  return catalog.plugins.map((entry) => ({
    name: marketplaceNameOf(
      entry.name,
      `${where}: the entry with source ${JSON.stringify(entry.source)}`,
    ),
    source: sourceDirOf(entry.source, where),
  }));
}

export function versionAt(repo: PluginDir, commit: CommitId, source: SourceDir): Version {
  const path = `${source}/${MANIFEST}`;

  return versionOf(jsonAt<ManifestFile>(repo, commit, path).version, `${path} at ${commit}`);
}

/**
 * Each plugin both catalogs list whose directory changed between `base` and
 * `head` while its `plugin.json` version did not. A plugin is matched by its
 * entry's name, so a directory that moved is compared with where it was.
 */
export function unbumped(repo: PluginDir, base: CommitId, head: CommitId): readonly Unbumped[] {
  const changed = git(repo, ["diff", "--name-only", "--no-renames", "-z", base, head])
    .split("\0")
    .filter((path) => path !== "");

  const released = new Map(catalogAt(repo, base).map(({ name, source }) => [name, source]));

  return catalogAt(repo, head).flatMap(({ name, source }) => {
    const releasedSource = released.get(name);

    if (releasedSource === undefined) return [];

    const dirs = [`${source}/`, `${releasedSource}/`];

    if (!changed.some((path) => dirs.some((dir) => path.startsWith(dir)))) return [];

    const version = versionAt(repo, head, source);

    return versionAt(repo, base, releasedSource) === version ? [{ name, source, version }] : [];
  });
}

function releasesIn(pushed: readonly PushedRef[]): readonly Release[] {
  return pushed.map(({ local, remoteRef, remote }) => {
    if (remote === null) {
      throw new Error(
        `${remoteRef} does not exist on the remote (null remote oid), so no release to compare with`,
      );
    }

    return { base: remote, head: local };
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
