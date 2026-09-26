import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type ChangelogSection,
  type IsoDate,
  isoDateOf,
  missingEntry,
  notesSince,
  parseChangelog,
  type Semver,
  semverOf,
  versionCommits,
} from "./changelog.ts";
import { type CommitId, commitAt, sourceDirOf } from "./check-plugin-bumps.ts";
import { type PluginDir, pluginDirAt } from "./lib/plugin-sources.ts";

const THREE = `# Changelog

Intro.

## 0.16.0 - 2026-09-25

### Added

- A Review button.

## 0.15.1 - 2026-09-25

### Fixed

- Runs on Windows.

## 0.2.0 - 2026-09-16

Internal changes only: tests, docs or refactoring.
`;

function sections(text: string): readonly ChangelogSection[] {
  const parsed = parseChangelog(text);

  if (!parsed.ok) throw new Error(`line ${parsed.line}: ${parsed.reason}`);

  return parsed.sections;
}

function version(text: string): Semver {
  const checked = semverOf(text);

  if (checked === null) throw new Error(`not x.y.z: ${text}`);

  return checked;
}

function date(text: string): IsoDate {
  const checked = isoDateOf(text);

  if (checked === null) throw new Error(`not YYYY-MM-DD: ${text}`);

  return checked;
}

function dir(path: string): PluginDir {
  const checked = pluginDirAt(path);

  if (checked === null) throw new Error(`not a directory: ${path}`);

  return checked;
}

const EXAMPLE = sourceDirOf("./example", "the fixture");

const VELLUM = sourceDirOf("./vellum", "the repository");

describe("parseChangelog", () => {
  test("reads each section, newest first, its body trimmed", () => {
    expect(sections(THREE)).toEqual([
      {
        version: version("0.16.0"),
        date: date("2026-09-25"),
        body: "### Added\n\n- A Review button.",
      },
      {
        version: version("0.15.1"),
        date: date("2026-09-25"),
        body: "### Fixed\n\n- Runs on Windows.",
      },
      {
        version: version("0.2.0"),
        date: date("2026-09-16"),
        body: "Internal changes only: tests, docs or refactoring.",
      },
    ]);
  });

  test("refuses a ## line that is not a version heading, naming its line", () => {
    expect(parseChangelog("# Changelog\n\n## Unreleased\n")).toEqual({
      ok: false,
      line: 3,
      reason: 'not a "## <x.y.z> - <YYYY-MM-DD>" heading: ## Unreleased',
    });
    expect(parseChangelog("## 0.2 - 2026-09-16\n")).toHaveProperty("ok", false);
    expect(parseChangelog("## 0.2.0 - 16/09/2026\n")).toHaveProperty("ok", false);
  });

  test("refuses a version older than the one above it, or the same one twice", () => {
    expect(parseChangelog("## 0.2.0 - 2026-09-16\n## 0.10.0 - 2026-09-21\n")).toEqual({
      ok: false,
      line: 2,
      reason: "0.10.0 follows 0.2.0, not newest first",
    });
    expect(parseChangelog("## 0.2.0 - 2026-09-16\n## 0.2.0 - 2026-09-16\n")).toHaveProperty(
      "ok",
      false,
    );
  });
});

describe("missingEntry", () => {
  test("is null when the version has its section", () => {
    expect(missingEntry("vellum/CHANGELOG.md", sections(THREE), version("0.15.1"))).toBeNull();
  });

  test("names the file and the version it lacks", () => {
    expect(missingEntry("vellum/CHANGELOG.md", sections(THREE), version("0.16.1"))).toBe(
      'vellum/CHANGELOG.md has no "## 0.16.1 - <YYYY-MM-DD>" section: write it in the commit that sets the version',
    );
  });
});

describe("notesSince", () => {
  test("keeps the sections newer than the version shipped, newest first", () => {
    expect(notesSince(sections(THREE), version("0.15.1"))).toBe(
      "## 0.16.0 - 2026-09-25\n\n### Added\n\n- A Review button.",
    );
  });

  test("keeps every section when nothing was shipped before", () => {
    expect(
      notesSince(sections(THREE), null)
        .split("\n")
        .filter((line) => line.startsWith("## ")),
    ).toEqual(["## 0.16.0 - 2026-09-25", "## 0.15.1 - 2026-09-25", "## 0.2.0 - 2026-09-16"]);
  });

  test("is empty when the version shipped is the newest", () => {
    expect(notesSince(sections(THREE), version("0.16.0"))).toBe("");
  });
});

describe("versionCommits", () => {
  let repo: PluginDir;

  function write(path: string, content: string) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }

  function commit(message: string, authored: string): CommitId {
    const env = { ...process.env, GIT_AUTHOR_DATE: `${authored}T12:00:00Z` };

    for (const args of [
      ["add", "-A"],
      ["commit", "-qm", message],
    ]) {
      const result = Bun.spawnSync(["git", "-C", repo, ...args], { env, stderr: "pipe" });

      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }

    return commitAt(repo, "HEAD");
  }

  function manifest(set: string, description = "") {
    write(
      "example/.claude-plugin/plugin.json",
      JSON.stringify({ name: "example", version: set, description }),
    );
  }

  beforeEach(() => {
    repo = dir(mkdtempSync(join(tmpdir(), "changelog-")));
    Bun.spawnSync(["git", "init", "-q", "-b", "dev", repo]);
    Bun.spawnSync(["git", "-C", repo, "config", "user.email", "t@example.com"]);
    Bun.spawnSync(["git", "-C", repo, "config", "user.name", "t"]);
    Bun.spawnSync(["git", "-C", repo, "config", "commit.gpgsign", "false"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("lists each version by the manifest, a bump folded into a feature commit included, and skips an edit that kept it", () => {
    manifest("0.1.0");
    const first = commit("feat(example): first", "2026-09-15");

    write("example/a.ts", "a\n");
    commit("feat(example): a", "2026-09-16");
    manifest("0.1.0", "same version, new description");
    commit("docs(example): describe", "2026-09-16");
    write("example/b.ts", "b\n");
    manifest("0.2.0");
    const folded = commit("feat(example): b, its bump folded in (#12)", "2026-09-17");

    expect(versionCommits(repo, EXAMPLE, folded)).toEqual([
      {
        version: version("0.1.0"),
        commit: first,
        previous: null,
        date: date("2026-09-15"),
        commits: 1,
      },
      {
        version: version("0.2.0"),
        commit: folded,
        previous: first,
        date: date("2026-09-17"),
        commits: 3,
      },
    ]);
  });

  test("raises an author date that runs backwards to the previous version's", () => {
    manifest("0.1.0");
    commit("feat(example): first", "2026-09-21");
    manifest("0.2.0");
    const later = commit("feat(example): rebased from an older branch", "2026-09-20");

    expect(versionCommits(repo, EXAMPLE, later).map((found) => found.date)).toEqual([
      date("2026-09-21"),
      date("2026-09-21"),
    ]);
  });
});

describe("vellum/CHANGELOG.md", () => {
  test("has one section for each version its history set, and no other", () => {
    const root = dir(join(import.meta.dir, ".."));
    const text = readFileSync(join(root, "vellum", "CHANGELOG.md"), "utf8");

    const set = versionCommits(root, VELLUM, commitAt(root, "HEAD"))
      .map(({ version: v }) => v)
      .toReversed();

    expect(sections(text).map(({ version: v }) => v)).toEqual(set);
  });
});
