#!/usr/bin/env bun

/**
 * The release step, run by the human in place of `git push origin dev:main`:
 * push, then tag each plugin that keeps a `CHANGELOG.md` and shipped a new
 * version, on the commit that set it, and publish its GitHub Release.
 *
 *   bun ./scripts/release.ts [<ref>]              # default: origin/dev
 *   bun ./scripts/release.ts --dry-run [<ref>]    # print the plan, push nothing
 *
 * Everything is read and checked before the push: a changelog that does not
 * parse, or a tag that already exists, stops the release with `main` unmoved.
 * The notes are the changelog's sections newer than the version `main` held,
 * written into the annotated tag, and the Release reads them back from it.
 * Never: a tag before the push landed, a tag moved, a changelog written.
 */

import {
  CHANGELOG,
  notesSince,
  parseChangelog,
  type Semver,
  semverOf,
  versionCommits,
} from "./changelog.ts";
import {
  catalogAt,
  type CommitId,
  commitAt,
  type MarketplaceName,
  versionAt,
} from "./check-plugin-bumps.ts";
import { type PluginDir, pluginDirAt } from "./lib/plugin-sources.ts";

const REMOTE = "origin";

const MAIN = `${REMOTE}/main`;

const DEFAULT_REF = `${REMOTE}/dev`;

/** An annotated tag's name, `<marketplace name>-v<x.y.z>`. */
export type TagName = string & { readonly __brand: "TagName" };

export interface PlannedTag {
  readonly name: MarketplaceName;
  readonly version: Semver;
  readonly tag: TagName;
  /** The commit that set `version`: the tag goes there, not on the release head. */
  readonly commit: CommitId;
  /** The changelog's sections newer than the version `main` held. */
  readonly notes: string;
}

export type ReleaseOutcome =
  | { readonly kind: "released"; readonly tags: readonly PlannedTag[] }
  | { readonly kind: "push-refused"; readonly why: string }
  | {
      readonly kind: "tag-failed";
      readonly tag: TagName;
      readonly step: string;
      readonly why: string;
    };

/** One command of a tag's publication, named for the message that reports its failure. */
interface Step {
  readonly step: string;
  readonly cmd: readonly string[];
  readonly stdin?: string;
}

interface Run {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

function run(cmd: readonly string[], cwd: string, stdin?: string): Run {
  const result = Bun.spawnSync([...cmd], {
    cwd,
    env: process.env,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString(),
    err: result.stderr.toString().trim(),
  };
}

function git(repo: PluginDir, args: readonly string[]): string {
  const result = run(["git", ...args], repo);

  if (!result.ok) throw new Error(`git ${args.join(" ")}: ${result.err}`);

  return result.out;
}

export function tagNameOf(name: MarketplaceName, version: Semver): TagName {
  // SAFETY: the brand states `<name>-v<x.y.z>`, built from a checked name and version.
  return `${name}-v${version}` as TagName;
}

function fileAt(repo: PluginDir, commit: CommitId, path: string): string | null {
  const result = run(["git", "cat-file", "-p", `${commit}:${path}`], repo);

  return result.ok ? result.out : null;
}

function tagExists(repo: PluginDir, tag: TagName): boolean {
  return run(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], repo).ok;
}

/**
 * The tags a release from `shipped` to `target` makes: one per plugin that
 * keeps a changelog and whose version moved. Reads only; refuses, before any
 * push, a changelog that does not parse, a version it lacks, or a tag that exists.
 */
export function plannedTags(
  repo: PluginDir,
  shipped: CommitId,
  target: CommitId,
): readonly PlannedTag[] {
  const before = new Map(catalogAt(repo, shipped).map(({ name, source }) => [name, source]));

  return catalogAt(repo, target).flatMap(({ name, source }) => {
    const file = `${source}/${CHANGELOG}`;
    const text = fileAt(repo, target, file);

    if (text === null) return [];

    const read = versionAt(repo, target, source);
    const version = semverOf(read);

    if (version === null) throw new Error(`${name}: version ${read} is not x.y.z`);

    const sourceBefore = before.get(name);
    const previous = sourceBefore === undefined ? null : versionAt(repo, shipped, sourceBefore);

    if (previous === version) return [];

    const parsed = parseChangelog(text);

    if (!parsed.ok) throw new Error(`${file}:${parsed.line}: ${parsed.reason}`);

    const set = versionCommits(repo, source, target).find((found) => found.version === version);

    if (set === undefined) throw new Error(`${name}: no commit sets ${version} in its history`);

    const tag = tagNameOf(name, version);

    if (tagExists(repo, tag)) throw new Error(`${tag} exists already: a tag is never moved`);

    const notes = notesSince(parsed.sections, previous === null ? null : semverOf(previous));

    if (notes === "") throw new Error(`${file} has no section newer than ${previous}`);

    return [{ name, version, tag, commit: set.commit, notes }];
  });
}

/** Push `target` to main, then tag and publish each planned tag, stopping at the first failure. */
export function release(
  repo: PluginDir,
  target: CommitId,
  tags: readonly PlannedTag[],
): ReleaseOutcome {
  const pushed = run(["git", "push", REMOTE, `${target}:refs/heads/main`], repo);

  if (!pushed.ok) return { kind: "push-refused", why: pushed.err };

  for (const planned of tags) {
    const steps: readonly Step[] = [
      {
        step: "tag",
        // verbatim: the default `strip` cleanup drops every line starting with `#`, the headings included.
        cmd: ["git", "tag", "-a", "--cleanup=verbatim", "-F", "-", planned.tag, planned.commit],
        stdin: `${planned.notes}\n`,
      },
      { step: "push the tag", cmd: ["git", "push", REMOTE, `refs/tags/${planned.tag}`] },
      {
        step: "publish the Release",
        cmd: [
          "gh",
          "release",
          "create",
          planned.tag,
          "--verify-tag",
          "--title",
          `${planned.name} ${planned.version}`,
          "--notes-from-tag",
        ],
      },
    ];

    for (const { step, cmd, stdin } of steps) {
      const result = run(cmd, repo, stdin);

      if (!result.ok) return { kind: "tag-failed", tag: planned.tag, step, why: result.err };
    }
  }

  return { kind: "released", tags };
}

function repositoryAt(cwd: string): PluginDir {
  const top = run(["git", "rev-parse", "--show-toplevel"], cwd);
  const root = top.ok ? pluginDirAt(top.out.trim()) : null;

  if (root === null) throw new Error(`not in a git working tree: ${cwd}`);

  return root;
}

/** What the command prints, and its exit code. */
interface Report {
  readonly text: string;
  readonly exit: number;
}

/** What a release from `shipped` to `target` would do, for a person to confirm. */
export function describePlan(
  shipped: CommitId,
  target: CommitId,
  tags: readonly PlannedTag[],
): string {
  const push = `main ${shipped.slice(0, 7)} -> ${target.slice(0, 7)}`;

  if (tags.length === 0) return `${push}\nno plugin that keeps a changelog changed version: no tag`;

  return [
    push,
    ...tags.flatMap(({ tag, commit, notes }) => [
      `${tag} on ${commit.slice(0, 7)}, with the sections:`,
      ...notes
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => `  ${line.slice("## ".length)}`),
    ]),
  ].join("\n");
}

function describe(outcome: ReleaseOutcome): Report {
  switch (outcome.kind) {
    case "released":
      return {
        text:
          outcome.tags.length === 0
            ? "main moved; no plugin that keeps a changelog changed version: nothing to tag"
            : outcome.tags.map(({ tag }) => `released ${tag}`).join("\n"),
        exit: 0,
      };
    case "push-refused":
      return { text: `the push to main was refused, nothing tagged:\n${outcome.why}`, exit: 1 };
    case "tag-failed":
      return {
        text: `main moved, but ${outcome.tag} failed at "${outcome.step}":\n${outcome.why}\nFinish that step by hand, then any tag after it.`,
        exit: 1,
      };
  }
}

if (import.meta.main) {
  try {
    const all = process.argv.slice(2);
    const dryRun = all[0] === "--dry-run";
    const args = dryRun ? all.slice(1) : all;

    if (args.length > 1) {
      console.error("Usage: bun ./scripts/release.ts [--dry-run] [<ref>]");
      process.exit(2);
    }

    const repo = repositoryAt(process.cwd());

    git(repo, ["fetch", "--quiet", REMOTE]);
    const shipped = commitAt(repo, MAIN);
    const target = commitAt(repo, args[0] ?? DEFAULT_REF);
    const tags = plannedTags(repo, shipped, target);

    if (dryRun) {
      console.log(describePlan(shipped, target, tags));
    } else {
      const { text, exit } = describe(release(repo, target, tags));

      console.log(text);
      process.exitCode = exit;
    }
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
