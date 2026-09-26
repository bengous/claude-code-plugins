import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type CommitId, commitAt } from "./check-plugin-bumps.ts";
import { type PluginDir, pluginDirAt } from "./lib/plugin-sources.ts";
import { plannedTags, release } from "./release.ts";

let root = "";

let repo: PluginDir;

let origin = "";

let ghLog = "";

let savedPath = "";

function dir(path: string): PluginDir {
  const checked = pluginDirAt(path);

  if (checked === null) throw new Error(`not a directory: ${path}`);

  return checked;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

function write(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function catalog(...entries: { name: string; source: string }[]) {
  write(".claude-plugin/marketplace.json", JSON.stringify({ name: "test", plugins: entries }));
}

function manifest(source: string, set: string) {
  write(`${source}/.claude-plugin/plugin.json`, JSON.stringify({ name: source, version: set }));
}

function changelog(source: string, ...versions: string[]) {
  write(
    `${source}/CHANGELOG.md`,
    [
      "# Changelog",
      "",
      ...versions.flatMap((v) => [
        `## ${v} - 2026-09-26`,
        "",
        "### Added",
        "",
        `- Change ${v}.`,
        "",
      ]),
    ].join("\n"),
  );
}

function commit(message: string): CommitId {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);

  return commitAt(repo, "HEAD");
}

function shipped(): CommitId {
  git(repo, "fetch", "--quiet", "origin");

  return commitAt(repo, "origin/main");
}

function tagMessage(tag: string): string {
  return git(repo, "for-each-ref", "--format=%(contents)", `refs/tags/${tag}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release-"));
  origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", origin);
  mkdirSync(join(root, "repo"));
  repo = dir(join(root, "repo"));
  git(repo, "init", "-q", "-b", "dev");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "tag.gpgsign", "false");
  git(repo, "remote", "add", "origin", origin);

  const bin = join(root, "bin");
  ghLog = join(root, "gh.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  savedPath = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${savedPath}`;

  catalog({ name: "vellum", source: "./vellum" }, { name: "other", source: "./other" });
  manifest("vellum", "0.1.0");
  changelog("vellum", "0.1.0");
  manifest("other", "1.0.0");
  commit("first");
  git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/main");
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

describe("a release", () => {
  test("tags the commit that set the version, with every section since the one main held", () => {
    manifest("vellum", "0.2.0");
    changelog("vellum", "0.2.0", "0.1.0");
    const setTwo = commit("feat(vellum): two, its bump folded in");

    write("vellum/a.ts", "a\n");
    manifest("vellum", "0.2.1");
    changelog("vellum", "0.2.1", "0.2.0", "0.1.0");
    const setThree = commit("fix(vellum): a");

    write("vellum/b.ts", "b\n");
    const head = commit("test(vellum): b");
    const tags = plannedTags(repo, shipped(), head);

    expect(tags.map(({ tag, commit: at }) => [`${tag}`, at])).toEqual([
      ["vellum-v0.2.1", setThree],
    ]);
    expect(release(repo, head, tags)).toEqual({ kind: "released", tags });
    expect(git(repo, "rev-parse", "vellum-v0.2.1^{commit}")).toBe(setThree);
    expect(setTwo).not.toBe(setThree);
    expect(tagMessage("vellum-v0.2.1")).toBe(
      "## 0.2.1 - 2026-09-26\n\n### Added\n\n- Change 0.2.1.\n\n## 0.2.0 - 2026-09-26\n\n### Added\n\n- Change 0.2.0.",
    );
    expect(git(origin, "rev-parse", "refs/tags/vellum-v0.2.1^{commit}")).toBe(setThree);
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
    expect(readFileSync(ghLog, "utf8")).toBe(
      "release create vellum-v0.2.1 --verify-tag --title vellum 0.2.1 --notes-from-tag\n",
    );
  });

  test("tags nothing when no plugin that keeps a changelog changed version", () => {
    manifest("other", "1.1.0");
    const head = commit("feat(other): no changelog kept");
    const tags = plannedTags(repo, shipped(), head);

    expect(tags).toEqual([]);
    expect(release(repo, head, tags)).toEqual({ kind: "released", tags: [] });
    expect(git(repo, "tag", "--list")).toBe("");
  });

  test("tags nothing when the push to main is refused", () => {
    writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho refused >&2\nexit 1\n");
    chmodSync(join(origin, "hooks", "pre-receive"), 0o755);
    manifest("vellum", "0.2.0");
    changelog("vellum", "0.2.0", "0.1.0");
    const head = commit("feat(vellum): two");
    const outcome = release(repo, head, plannedTags(repo, shipped(), head));

    expect(outcome).toHaveProperty("kind", "push-refused");
    expect(git(repo, "tag", "--list")).toBe("");
  });

  test("a plugin new since main takes every section of its changelog", () => {
    catalog(
      { name: "vellum", source: "./vellum" },
      { name: "other", source: "./other" },
      { name: "fresh", source: "./fresh-dir" },
    );
    manifest("fresh-dir", "0.2.0");
    changelog("fresh-dir", "0.2.0", "0.1.0");
    const head = commit("feat(fresh): a new plugin");
    const [tag] = plannedTags(repo, shipped(), head);

    expect(`${tag?.tag}`).toBe("fresh-v0.2.0");
    expect(tag?.notes.split("\n").filter((line) => line.startsWith("## "))).toEqual([
      "## 0.2.0 - 2026-09-26",
      "## 0.1.0 - 2026-09-26",
    ]);
  });

  test("is refused before the push when the tag exists already", () => {
    manifest("vellum", "0.2.0");
    changelog("vellum", "0.2.0", "0.1.0");
    const head = commit("feat(vellum): two");

    git(repo, "tag", "vellum-v0.2.0", "HEAD~1");

    expect(() => plannedTags(repo, shipped(), head)).toThrow(
      "vellum-v0.2.0 exists already: a tag is never moved",
    );
  });

  test("is refused before the push when the changelog does not parse", () => {
    manifest("vellum", "0.2.0");
    write("vellum/CHANGELOG.md", "# Changelog\n\n## next\n");
    const head = commit("feat(vellum): two");

    expect(() => plannedTags(repo, shipped(), head)).toThrow("vellum/CHANGELOG.md:3");
  });
});
