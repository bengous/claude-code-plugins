import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadApprovals } from "../config.ts";
import { isRecord, recordField, stringField } from "../json.ts";
import type { PackageScript } from "./argv.ts";
import type { Vocabulary } from "./mentions.ts";
import { findMentions, mentionsGh, mentionsGit, mentionsPackageManager } from "./mentions.ts";
import { git, keyRead, profileOf, rootOf } from "./repo.ts";

type Manifest = { readonly dir: string; readonly scripts: ReadonlyMap<string, string> };

/** The nearest `package.json` from `dir` up and its scripts, as a package manager finds it; no scripts when it does not parse. */
export function manifestOf(dir: string): Manifest | null {
  for (let current = dir; ; current = path.dirname(current)) {
    const file = path.join(current, "package.json");

    if (existsSync(file)) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return { dir: current, scripts: new Map() };
      }

      const scripts = (isRecord(parsed) ? recordField(parsed, "scripts") : undefined) ?? {};

      return {
        dir: current,
        scripts: new Map(
          Object.keys(scripts).flatMap((name) => {
            const command = stringField(scripts, name);

            return command === undefined ? [] : [[name, command] as const];
          }),
        ),
      };
    }

    if (path.dirname(current) === current) {
      return null;
    }
  }
}

/** The commands a package script runs, with its pre and post scripts, in the order a package manager runs them. */
export function scriptCommands(script: PackageScript, manifest: Manifest): string[] {
  return [`pre${script.name}`, script.name, `post${script.name}`].flatMap((name) => {
    const command = manifest.scripts.get(name);

    if (command === undefined) {
      return [];
    }

    return [name === script.name ? [command, ...script.args].join(" ") : command];
  });
}

const NO_VOCABULARY: Vocabulary = {
  gitAliases: new Set(),
  doorScriptNames: new Set(),
  doorScriptsAt: () => new Set(),
  profiledAt: () => true,
  approvals: false,
};

/** The git aliases, read from git's own config at `cwd`, whose expansion pushes: `push`, or a `!` command that does. */
function doorAliases(cwd: string, approvals: boolean): Set<string> {
  const listing = existsSync(cwd) ? git(cwd, [], ["config", "--get-regexp", "^alias\\."]) : null;
  const doors = new Set<string>();

  for (const line of listing?.split("\n") ?? []) {
    const match = /^alias\.(\S+)\s+(.*)$/u.exec(line);
    const [, name, value = ""] = match ?? [];
    const expansion = value.startsWith("!") ? value.slice(1) : `git ${value}`;

    if (name !== undefined && findMentions(expansion, { ...NO_VOCABULARY, approvals }).length > 0) {
      doors.add(name);
    }
  }

  return doors;
}

/** The scripts of `manifest` that open a door, directly or through another such script. */
function doorScriptsIn(
  manifest: Manifest,
  gitAliases: ReadonlySet<string>,
  approvals: boolean,
): Set<string> {
  const doors = new Set<string>();

  for (let changed = true; changed;) {
    changed = false;

    for (const [name, command] of manifest.scripts) {
      const vocabulary = { ...NO_VOCABULARY, gitAliases, doorScriptNames: doors, approvals };

      if (!doors.has(name) && findMentions(command, vocabulary).length > 0) {
        doors.add(name);
        changed = true;
      }
    }
  }

  return doors;
}

/** Whether the repository around `dir` has a profile, or one the guard cannot read, which guards its doors too. */
function profiledAt(dir: string): boolean {
  const root = existsSync(dir) ? rootOf(dir, []) : null;

  return root !== null && profileOf(root).kind !== "default";
}

const DIRECTORY_WORD =
  /(?:^|[\s;&|(])(?:cd|pushd|--cwd|--prefix|--dir|-C)[\s=]+("[^"]*"|'[^']*'|[^\s;&|)]+)/gu;

/** `cwd` and the targets of the line's `cd`, `--cwd`, `--prefix` and `-C`. */
function namedDirs(command: string, cwd: string): string[] {
  const named = [...command.matchAll(DIRECTORY_WORD)].map((match) =>
    path.resolve(cwd, (match[1] ?? "").replaceAll(/^["']|["']$/gu, "")),
  );

  return [...new Set([cwd, ...named])];
}

/** The directories a line can reach: the ones it names, and their parents. */
function reachableDirs(command: string, cwd: string): string[] {
  return [...new Set(namedDirs(command, cwd).flatMap((dir) => ancestorsOf(dir)))];
}

/** Whether the repository around `dir` declares profile.approvals, or a file whose approvals the guard cannot read. */
function approvalsAt(dir: string): boolean {
  const root = existsSync(dir) ? rootOf(dir, []) : null;

  return root !== null && keyRead(root, loadApprovals).kind !== "absent";
}

function ancestorsOf(dir: string): string[] {
  const parent = path.dirname(dir);

  return parent === dir ? [dir] : [dir, ...ancestorsOf(parent)];
}

/** `read` once per directory: a line asks the same directory for each of its mentions. */
function memoized<T>(read: (dir: string) => T): (dir: string) => T {
  const known = new Map<string, T>();

  return (dir) => {
    const cached = known.get(dir);

    if (cached !== undefined) {
      return cached;
    }

    const value = read(dir);
    known.set(dir, value);

    return value;
  };
}

export function vocabularyOf(command: string, cwd: string): Vocabulary {
  const approvals = mentionsGh(command) && namedDirs(command, cwd).some((dir) => approvalsAt(dir));
  const gitAliases = mentionsGit(command) ? doorAliases(cwd, approvals) : new Set<string>();

  const scriptsOfManifest = memoized((dir) => {
    const manifest = manifestOf(dir);

    return manifest === null ? new Set<string>() : doorScriptsIn(manifest, gitAliases, approvals);
  });

  const doorScriptsAt = (dir: string): ReadonlySet<string> =>
    scriptsOfManifest(manifestOf(dir)?.dir ?? dir);

  const doorScriptNames = mentionsPackageManager(command)
    ? new Set(reachableDirs(command, cwd).flatMap((dir) => [...doorScriptsAt(dir)]))
    : new Set<string>();

  return {
    gitAliases,
    doorScriptNames,
    doorScriptsAt,
    profiledAt: memoized(profiledAt),
    approvals,
  };
}
