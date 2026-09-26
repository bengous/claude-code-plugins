/**
 * A plugin's `CHANGELOG.md`: one `## <x.y.z> - <YYYY-MM-DD>` section per
 * version, newest first, written by whoever bumps the version. The file is the
 * source of a release's notes; nothing regenerates it.
 *
 * Two boundaries, each validated where it is read: the file's text
 * (`parseChangelog`) and git's output (`versionCommits`). Past them, a value
 * carries a brand that says what was checked.
 */

import { type CommitId, type SourceDir, type Version, versionAt } from "./check-plugin-bumps.ts";
import type { PluginDir } from "./lib/plugin-sources.ts";

export const CHANGELOG = "CHANGELOG.md";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

const HEADING = /^## (\S+) - (\S+)$/u;

const LOG_LINE = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/u;

/** A `Version` of the form `x.y.z`, the only one a changelog heading or a release compares. */
export type Semver = Version & { readonly __semver: true };

/** A calendar date, `YYYY-MM-DD`. */
export type IsoDate = string & { readonly __brand: "IsoDate" };

export interface ChangelogSection {
  readonly version: Semver;
  readonly date: IsoDate;
  /** The lines under the heading, trimmed. */
  readonly body: string;
}

export type ParsedChangelog =
  | { readonly ok: true; readonly sections: readonly ChangelogSection[] }
  | { readonly ok: false; readonly line: number; readonly reason: string };

export interface VersionCommit {
  readonly version: Semver;
  /** The first commit where `plugin.json` reads this version. */
  readonly commit: CommitId;
  /** The commit that set the version before it, null for the first. */
  readonly previous: CommitId | null;
  /**
   * The commit's author date, raised to the previous version's when earlier: a
   * rebase moves committer dates to the day it ran, and leaves author dates out
   * of order across the branches it lined up.
   */
  readonly date: IsoDate;
  /** Commits under the plugin's directory since `previous`, this one included. */
  readonly commits: number;
}

type SemverParts = readonly [major: number, minor: number, patch: number];

export function semverOf(text: string): Semver | null {
  // SAFETY: the brand states `x.y.z`, three decimal parts, checked by SEMVER.
  return SEMVER.test(text) ? (text as Semver) : null;
}

export function isoDateOf(text: string): IsoDate | null {
  // SAFETY: the brand states `YYYY-MM-DD`, checked by ISO_DATE.
  return ISO_DATE.test(text) ? (text as IsoDate) : null;
}

function partsOf(version: Semver): SemverParts {
  const [, major = "", minor = "", patch = ""] = SEMVER.exec(version) ?? [];

  return [Number(major), Number(minor), Number(patch)];
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareSemver(a: Semver, b: Semver): number {
  const [aMajor, aMinor, aPatch] = partsOf(a);
  const [bMajor, bMinor, bPatch] = partsOf(b);

  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

/** The sections, newest first. A `## ` line that is not a heading, or a version out of order, is refused with its line. */
export function parseChangelog(text: string): ParsedChangelog {
  const found: { version: Semver; date: IsoDate; lines: string[] }[] = [];

  for (const [index, line] of text.split("\n").entries()) {
    if (!line.startsWith("## ")) {
      found.at(-1)?.lines.push(line);
      continue;
    }

    const lineNumber = index + 1;
    const [, versionText = "", dateText = ""] = HEADING.exec(line) ?? [];
    const version = semverOf(versionText);
    const date = isoDateOf(dateText);

    if (version === null || date === null) {
      return {
        ok: false,
        line: lineNumber,
        reason: `not a "## <x.y.z> - <YYYY-MM-DD>" heading: ${line}`,
      };
    }

    const above = found.at(-1);

    if (above !== undefined && compareSemver(version, above.version) >= 0) {
      return {
        ok: false,
        line: lineNumber,
        reason: `${version} follows ${above.version}, not newest first`,
      };
    }

    found.push({ version, date, lines: [] });
  }

  return {
    ok: true,
    sections: found.map(({ version, date, lines }) => ({
      version,
      date,
      body: lines.join("\n").trim(),
    })),
  };
}

/** The refusal for a version the file has no section for, or null. */
export function missingEntry(
  file: string,
  sections: readonly ChangelogSection[],
  version: Version,
): string | null {
  if (sections.some((section) => section.version === version)) return null;

  return `${file} has no "## ${version} - <YYYY-MM-DD>" section: write it in the commit that sets the version`;
}

/** Every section newer than `shipped`, newest first, as a release's notes; all of them when `shipped` is null. */
export function notesSince(sections: readonly ChangelogSection[], shipped: Semver | null): string {
  return sections
    .flatMap(({ version, date, body }) =>
      shipped === null || compareSemver(version, shipped) > 0
        ? [`## ${version} - ${date}\n\n${body}`]
        : [],
    )
    .join("\n\n");
}

function git(repo: PluginDir, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString();
}

/** One line of `git log --format="%H %as"`. */
interface LogLine {
  readonly commit: CommitId;
  readonly date: IsoDate;
}

function logLineOf(line: string): LogLine {
  const [, hash, dateText = ""] = LOG_LINE.exec(line) ?? [];
  const date = isoDateOf(dateText);

  if (hash === undefined || date === null) {
    throw new Error(`not a "<hash> <YYYY-MM-DD>" line from git log: ${JSON.stringify(line)}`);
  }

  // SAFETY: the brand states a commit git listed in this repository, its hash checked by LOG_LINE.
  return { commit: hash as CommitId, date };
}

function countOf(text: string, what: string): number {
  const count = Number(text.trim());

  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`${what}: not a count: ${JSON.stringify(text)}`);
  }

  return count;
}

/**
 * Each version `head`'s history set in `<source>/.claude-plugin/plugin.json`,
 * oldest first, found by the manifest's `version`, never by a commit's subject:
 * a version folded into a squashed feature commit counts as any other. A
 * version that is not `x.y.z` is refused, naming the commit.
 */
export function versionCommits(
  repo: PluginDir,
  source: SourceDir,
  head: CommitId,
): readonly VersionCommit[] {
  const manifest = `${source}/.claude-plugin/plugin.json`;

  const lines = git(repo, ["log", "--reverse", "--format=%H %as", head, "--", manifest])
    .split("\n")
    .filter((line) => line !== "");

  const found: VersionCommit[] = [];

  for (const line of lines) {
    const { commit, date } = logLineOf(line);
    const read = versionAt(repo, commit, source);
    const version = semverOf(read);

    if (version === null) throw new Error(`${manifest} at ${commit}: ${read} is not x.y.z`);

    const last = found.at(-1);

    if (last?.version === version) continue;

    const previous = last?.commit ?? null;
    const range = previous === null ? [commit] : [`${previous}..${commit}`];

    const commits = countOf(
      git(repo, ["rev-list", "--count", ...range, "--", source]),
      `commits under ${source} up to ${commit}`,
    );

    found.push({
      version,
      commit,
      previous,
      date: last !== undefined && last.date > date ? last.date : date,
      commits,
    });
  }

  return found;
}
