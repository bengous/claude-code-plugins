/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- expectations here are branded values (PluginVersion, CommitSha) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readVellumBuild } from "./vellum-build.ts";

const SHA = "0f9634d417d4307b2b8e3f63829899ea691bdd6e";

const kept = process.env["CLAUDE_CONFIG_DIR"];

afterEach(() => {
  if (kept === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = kept;
});

/** A plugin copy outside any repository, and a config dir whose installs file says `installs`. */
function installed(installs: (root: string) => object) {
  const base = mkdtempSync(join(tmpdir(), "vellum-build-"));
  const root = join(base, "cache", "vellum", "0.13.0");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), '{ "version": "0.13.0" }');
  const link = join(base, "linked");
  symlinkSync(root, link);
  mkdirSync(join(base, "config", "plugins"), { recursive: true });
  const file = join(base, "config", "plugins", "installed_plugins.json");
  writeFileSync(file, JSON.stringify(installs(root)));
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "config");

  return { root, link };
}

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

  test("an installs file of another shape reads as no entry, and the error says so", async () => {
    const { root } = installed(() => ({ plugins: "none" }));
    const built = await readVellumBuild(root);

    expect(!built.ok && built.error).toContain("installed_plugins.json: no entry");
  });
});
