/* oxlint-disable anti-slop/no-unknown-parameters -- these tests feed parseManifest malformed JSON on purpose: the untyped input IS what is under test. */

import { describe, expect, test } from "bun:test";

import { parseHandoff, parseManifest } from "./manifest.ts";

const OID = "a".repeat(40);

const valid = {
  base: "main",
  worktrees: ["/wt"],
  stale_worktrees: ["/gone"],
  branches: [{ name: "feature/x", force: false, oid: OID }],
  remote_branches: [{ remote: "origin", ref: "feature/x", oid: OID }],
  prune_remotes: true,
};

const errorOf = (raw: unknown): string => {
  const parsed = parseManifest(raw);

  if (!("error" in parsed)) throw new Error("expected a parse error");

  return parsed.error;
};

describe("parseManifest", () => {
  test("returns a well-formed manifest unchanged", () => {
    expect<unknown>(parseManifest(valid)).toEqual(valid);
  });

  test("accepts a SHA-256 commit id", () => {
    const sha256 = "b".repeat(64);

    expect<unknown>(
      parseManifest({ ...valid, branches: [{ ...valid.branches[0], oid: sha256 }] }),
    ).toEqual({
      ...valid,
      branches: [{ ...valid.branches[0], oid: sha256 }],
    });
  });

  test("refuses a field it does not know, so a manifest from another version is re-audited", () => {
    expect(errorOf({ ...valid, prune_worktrees: true })).toContain("prune_worktrees");
  });

  test("refuses an abbreviated commit id, which apply could never match", () => {
    expect(
      errorOf({ ...valid, branches: [{ name: "feature/x", force: false, oid: "abc1234" }] }),
    ).toContain("branches[0].oid");
  });

  test("refuses a branch name git would read as an option", () => {
    expect(errorOf({ ...valid, branches: [{ name: "-D", force: false, oid: OID }] })).toContain(
      "branches[0].name",
    );
    expect(
      errorOf({ ...valid, remote_branches: [{ remote: "origin", ref: "--all", oid: OID }] }),
    ).toContain("remote_branches[0].ref");
  });

  test("reads the hand-off, kept list included", () => {
    const kept = [{ name: "main", reason: "base", detail: null }];

    expect<unknown>(parseHandoff({ manifest: valid, kept })).toEqual({ manifest: valid, kept });
    expect(parseHandoff({ manifest: valid, kept: [{ name: "main" }] })).toHaveProperty("error");
    expect(parseHandoff({ manifest: valid })).toHaveProperty("error");
  });

  test("names the field that is missing or of the wrong type", () => {
    expect(errorOf({ ...valid, base: "" })).toContain("base");
    expect(errorOf({ ...valid, worktrees: [1] })).toContain("worktrees");
    expect(errorOf({ ...valid, branches: [{ name: "x", oid: OID }] })).toContain(
      "branches[0].force",
    );
    expect(errorOf({ ...valid, remote_branches: [{ ref: "x", oid: OID }] })).toContain(
      "remote_branches[0].remote",
    );
    expect(errorOf({ ...valid, prune_remotes: "yes" })).toContain("prune_remotes");
    expect(errorOf([])).toContain("object");
  });
});
