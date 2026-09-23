/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- expectations here are branded values (PluginVersion, CommitSha) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";

import type { ParseResult } from "./paths.ts";
import { vellumBuildOf } from "./vellum-build.ts";

const ROOT = "/opt/plugins/cache/market/vellum/0.13.0";

const INSTALLED = "0f9634d417d4307b2b8e3f63829899ea691bdd6e";

const HEAD = "a7ad886f0000000000000000000000000000beef";

const ok = (value: string): ParseResult<string> => ({ ok: true, value });

const failed = (error: string): ParseResult<string> => ({ ok: false, error });

const SOURCES = {
  pluginRoot: ROOT,
  version: ok("0.13.0"),
  installed: failed("no entry"),
  head: ok(`${HEAD}\n`),
};

describe("vellumBuildOf", () => {
  test("the install entry's commit wins over the head", () => {
    const built = vellumBuildOf({ ...SOURCES, installed: ok(INSTALLED) });

    expect(built.ok && built.value).toEqual({ version: "0.13.0", commit: INSTALLED } as never);
  });

  test("without an install entry, the head is the commit, its newline trimmed", () => {
    const built = vellumBuildOf(SOURCES);

    expect(built.ok && built.value.commit).toBe(HEAD as never);
  });

  test("an install entry's SHA of another shape falls back to the head", () => {
    const built = vellumBuildOf({ ...SOURCES, installed: ok("0f9634d4") });

    expect(built.ok && built.value.commit).toBe(HEAD as never);
  });

  test("no entry and a failed head: the error names the root and both reasons", () => {
    const built = vellumBuildOf({ ...SOURCES, head: failed("fatal: not a git repository") });

    expect(built.ok).toBe(false);
    expect(!built.ok && built.error).toContain(ROOT);
    expect(!built.ok && built.error).toContain("installed_plugins.json: no entry");
    expect(!built.ok && built.error).toContain("fatal: not a git repository");
  });

  test("a version that is not MAJOR.MINOR.PATCH is refused", () => {
    for (const version of ["1.2", "v1.2.3", "1.2.3-beta"]) {
      expect(vellumBuildOf({ ...SOURCES, version: ok(version) }).ok).toBe(false);
    }
  });

  test("a manifest without a version passes its reason through", () => {
    const built = vellumBuildOf({ ...SOURCES, version: failed("/x/plugin.json: ENOENT") });

    expect(built).toEqual({ ok: false, error: "plugin.json: /x/plugin.json: ENOENT" });
  });

  test("a head of 39 characters, or in uppercase, is refused", () => {
    for (const head of [HEAD.slice(1), HEAD.toUpperCase()]) {
      expect(vellumBuildOf({ ...SOURCES, head: ok(head) }).ok).toBe(false);
    }
  });
});
