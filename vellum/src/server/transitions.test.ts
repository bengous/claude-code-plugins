/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";

import type { PlanWorkspace } from "../protocol.ts";
import { decideOn, gateVersion, pendingOf, slugFor, workspaceOf } from "./transitions.ts";

const DIR = "plans/2026-09-15/wip-4c2a9d93/" as never;

const V1 = 1 as never;

const drafting: PlanWorkspace = { kind: "drafting", dir: DIR };

const inReview: PlanWorkspace = { kind: "inReview", dir: DIR, version: V1, finalizeError: null };

const changesRequested: PlanWorkspace = { kind: "changesRequested", dir: DIR, version: V1 };

const approvedPending: PlanWorkspace = { kind: "approvedPending", dir: DIR, version: V1 };

describe("workspaceOf", () => {
  test.each([
    ["none", { kind: "none" }, inReview],
    ["approvedPending", { kind: "approvedPending", version: V1 }, approvedPending],
    [
      "finalizeError",
      { kind: "finalizeError", version: V1, error: "EACCES" },
      { ...inReview, finalizeError: "EACCES" },
    ],
  ] as const)("overlays %s on a plan under review", (_name, memory, expected) => {
    expect(workspaceOf(inReview, memory, DIR)).toEqual(expected);
  });

  test("the approved memory wins over the directory, which was renamed", () => {
    const memory = {
      kind: "approved",
      version: V1,
      dir: "plans/2026-09-15/notes/" as never,
    } as const;

    expect(workspaceOf(drafting, memory, DIR)).toEqual({
      kind: "approved",
      dir: memory.dir,
      version: V1,
    });
  });
});

describe("pendingOf", () => {
  test.each([
    [drafting, { kind: "none" }],
    [inReview, { kind: "none" }],
    [changesRequested, { kind: "feedback", version: V1, path: `${DIR}.review/v1.feedback.md` }],
    [approvedPending, { kind: "approved", version: V1 }],
  ] as const)("reads what $kind leaves pending", (workspace, expected) => {
    expect(pendingOf(workspace)).toEqual(expected as never);
  });
});

describe("gateVersion", () => {
  test("the first plan is v1", () => {
    expect(gateVersion(drafting, null, "# P\n")).toEqual({ kind: "recorded", version: V1 });
  });

  test("the same text under review keeps its number", () => {
    expect(gateVersion(inReview, "# P\n", "# P\n")).toEqual({ kind: "kept", version: V1 });
  });

  test("the same text after a feedback is a new round", () => {
    expect(gateVersion(changesRequested, "# P\n", "# P\n")).toEqual({
      kind: "recorded",
      version: 2 as never,
    });
  });

  test("a new text is the next version", () => {
    expect(gateVersion(inReview, "# P\n", "# Q\n")).toEqual({
      kind: "recorded",
      version: 2 as never,
    });
  });
});

describe("decideOn", () => {
  test("approve marks the version as approved, pending the rename", () => {
    expect(decideOn(inReview, { kind: "approve" })).toEqual({
      kind: "approve",
      memory: { kind: "approvedPending", version: V1 },
    });
  });

  test("feedback names the file to write", () => {
    expect(decideOn(inReview, { kind: "feedback", annotations: [] })).toEqual({
      kind: "feedback",
      path: `${DIR}.review/v1.feedback.md` as never,
      version: V1,
    });
  });

  test.each([drafting, changesRequested, approvedPending])("is refused on $kind", (workspace) => {
    expect(decideOn(workspace, { kind: "approve" })).toEqual({ kind: "refused" });
  });
});

describe("slugFor", () => {
  test("the title first, the plan file's name without one", () => {
    expect(slugFor("# Notes\n", "plans/quiet-otter.md")).toEqual({
      ok: true,
      value: "notes" as never,
    });
    expect(slugFor("no heading", "plans/quiet-otter.md")).toEqual({
      ok: true,
      value: "quiet-otter" as never,
    });
  });
});
