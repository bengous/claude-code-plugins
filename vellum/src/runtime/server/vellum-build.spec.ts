/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- expectations here are branded values (PluginVersion, CommitSha) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readVellumBuild } from "./vellum-build.ts";

const SHA = "0f9634d417d4307b2b8e3f63829899ea691bdd6e";

const KEPT = process.env["CLAUDE_CONFIG_DIR"];

const bases: string[] = [];

afterEach(() => {
  if (KEPT === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = KEPT;

  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env["PATH"] ?? "" } })
    .stdout.toString()
    .trim();
}

/** A plugin copy outside any repository, and a config dir whose installs file says `installs`. */
function installed(installs: (root: string) => object) {
  const base = mkdtempSync(join(tmpdir(), "vellum-build-"));
  bases.push(base);
  const root = join(base, "cache", "vellum", "0.13.0");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), '{ "version": "0.13.0" }');
  const link = join(base, "linked");
  // A junction on Windows, which creates one with no privilege; a symbolic link elsewhere.
  symlinkSync(root, link, "junction");
  mkdirSync(join(base, "config", "plugins"), { recursive: true });
  const file = join(base, "config", "plugins", "installed_plugins.json");
  writeFileSync(file, JSON.stringify(installs(root)));
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "config");

  return { base, root, link };
}

const WITHOUT_SHA = (root: string) => ({ plugins: { "vellum@m": [{ installPath: root }] } });

describe("readVellumBuild", () => {
  test("the install entry of this root gives the commit, the root reached through a link", async () => {
    const { link } = installed((root) => ({
      plugins: { "vellum@m": [{ installPath: root, gitCommitSha: SHA }] },
    }));

    expect(await readVellumBuild(link)).toEqual({
      ok: true,
      value: { version: "0.13.0", commit: SHA },
    } as never);
  });

  test("of two entries on this root, the one updated last gives the commit", async () => {
    const OLDER = "40449a2b0000000000000000000000000000beef";

    const { root } = installed((path) => ({
      plugins: {
        "vellum@m": [
          {
            scope: "project",
            installPath: path,
            gitCommitSha: OLDER,
            lastUpdated: "2026-08-11T20:51:31.862Z",
          },
          {
            scope: "user",
            installPath: path,
            gitCommitSha: SHA,
            lastUpdated: "2026-08-14T14:11:37.724Z",
          },
        ],
      },
    }));

    const built = await readVellumBuild(root);

    expect(built.ok && built.value.commit).toBe(SHA as never);
  });

  test("an installs file of another shape reads as no entry, and the error says so", async () => {
    const { root } = installed(() => ({ plugins: "none" }));
    const built = await readVellumBuild(root);

    expect(!built.ok && built.error).toContain("installed_plugins.json: no entry");
  });

  test("a repository around the copy that does not track it gives no commit", async () => {
    const { base, root } = installed(WITHOUT_SHA);
    git(base, "init", "-q");
    git(
      base,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "dotfiles",
    );

    expect((await readVellumBuild(root)).ok).toBe(false);
  });
});
