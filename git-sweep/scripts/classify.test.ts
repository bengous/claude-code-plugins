import { describe, expect, test } from "bun:test";

import {
  type LocalContext,
  settleLocal,
  settleRemote,
  tooOld,
  triageLocal,
  triageRemote,
} from "./classify.ts";

const context: LocalContext = {
  held: new Map([
    ["feature/held", { name: "feature/held", reason: "dirty-worktree", detail: "/wt" }],
  ]),
  protectedBranches: new Set(["main", "release"]),
  merged: new Set(["feature/done", "worktree-agent-done", "backup/merged", "release"]),
  agentPrefix: "worktree-agent-",
  backupPrefix: "backup/",
};

describe("triageLocal", () => {
  test("keeps what a worktree holds, then what is protected, before any proof", () => {
    expect(triageLocal("feature/held", context)).toEqual({
      kind: "placed",
      placement: { kind: "kept", kept: { reason: "dirty-worktree", detail: "/wt" } },
    });
    expect(triageLocal("release", context)).toEqual({
      kind: "placed",
      placement: { kind: "kept", kept: { reason: "protected", detail: null } },
    });
  });

  test("places a branch merged by ancestry without a proof, agent ones apart", () => {
    expect(triageLocal("feature/done", context)).toEqual({
      kind: "placed",
      placement: { kind: "merged_local", proof: "ancestry" },
    });
    expect(triageLocal("worktree-agent-done", context)).toEqual({
      kind: "placed",
      placement: { kind: "orphaned_worktree", proof: "ancestry" },
    });
    expect(triageLocal("backup/merged", context)).toEqual({
      kind: "placed",
      placement: { kind: "merged_local", proof: "ancestry" },
    });
  });

  test("routes every other branch to the proof it needs", () => {
    expect(triageLocal("backup/pre-ship", context)).toEqual({ kind: "prove", route: "backup" });
    expect(triageLocal("worktree-agent-wip", context)).toEqual({ kind: "prove", route: "agent" });
    expect(triageLocal("feature/wip", context)).toEqual({ kind: "prove", route: "content" });
  });
});

describe("settleLocal", () => {
  test("lists a backup whatever its proof", () => {
    expect(settleLocal("backup", "unproven", "3 commits")).toEqual({
      kind: "backup",
      proof: "unproven",
    });
  });

  test("keeps an unproven agent or content branch with the detail", () => {
    for (const route of ["agent", "content"] as const) {
      expect(settleLocal(route, "unproven", "3 commits")).toEqual({
        kind: "kept",
        kept: { reason: "unproven", detail: "3 commits" },
      });
    }
  });

  test("places a proven agent or content branch in its category", () => {
    expect(settleLocal("agent", "merged-pr", "")).toEqual({
      kind: "orphaned_worktree",
      proof: "merged-pr",
    });
    expect(settleLocal("content", "no-merge-delta", "")).toEqual({
      kind: "content_merged",
      proof: "no-merge-delta",
    });
  });
});

describe("tooOld", () => {
  const now = new Date("2026-09-23T12:00:00Z");

  test("keeps a branch past the age bound untested, and lets a recent one through", () => {
    expect(tooOld({ lastCommit: new Date("2026-01-01T00:00:00Z"), maxAgeDays: 180, now })).toEqual({
      reason: "too-old",
      detail: "older than 180 days, containment not tested",
    });
    expect(tooOld({ lastCommit: new Date("2026-09-01T00:00:00Z"), maxAgeDays: 180, now })).toBe(
      null,
    );
  });

  test("refuses a date it cannot read instead of letting the branch through", () => {
    expect(() => tooOld({ lastCommit: new Date(""), maxAgeDays: 180, now })).toThrow();
  });
});

describe("remote branches", () => {
  const remote = { protectedBranches: new Set(["main"]), merged: new Set(["feature/done"]) };

  test("keeps a protected remote, lists a merged one, proves the rest", () => {
    expect(triageRemote("main", remote)).toEqual({
      kind: "kept",
      kept: { reason: "protected", detail: null },
    });
    expect(triageRemote("feature/done", remote)).toEqual({ kind: "stale", proof: "ancestry" });
    expect(triageRemote("feature/wip", remote)).toEqual({ kind: "prove" });
  });

  test("settles a proof against the remote base", () => {
    expect(settleRemote("unproven", "origin/main", null)).toEqual({
      kind: "kept",
      kept: { reason: "unproven", detail: "not proven to be in origin/main" },
    });
    expect(settleRemote("unproven", "origin/main", "PR #4: 1/2 commits match")).toEqual({
      kind: "kept",
      kept: {
        reason: "unproven",
        detail: "not proven to be in origin/main; PR #4: 1/2 commits match",
      },
    });
    expect(settleRemote("merged-pr", "origin/main", null)).toEqual({
      kind: "stale",
      proof: "merged-pr",
    });
  });
});
