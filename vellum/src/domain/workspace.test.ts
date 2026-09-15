/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";

import type { PlanWorkspace } from "./workspace.ts";
import { pendingOf, workspaceFromListing, workspaceOf } from "./workspace.ts";

const DIR = "plans/2026-09-15/wip-4c2a9d93/" as never;

const FINAL = "plans/2026-09-15/notification/" as never;

const V1 = 1 as never;

const drafting: PlanWorkspace = { kind: "drafting", dir: DIR };

const inReview: PlanWorkspace = { kind: "inReview", dir: DIR, version: V1, finalizeError: null };

const changesRequested: PlanWorkspace = { kind: "changesRequested", dir: DIR, version: V1 };

const approvedPending: PlanWorkspace = { kind: "approvedPending", dir: DIR, version: V1 };

function listing(...names: string[]): ReadonlySet<string> {
  return new Set(names);
}

describe("workspaceFromListing", () => {
  test("no version is drafting", () => {
    expect(workspaceFromListing(DIR, listing())).toEqual({ ok: true, value: drafting });
  });

  test("the latest version without its feedback is inReview", () => {
    const names = listing("v1.md", "v1.feedback.md", "v2.md");
    expect(workspaceFromListing(DIR, names)).toEqual({
      ok: true,
      value: { ...inReview, version: 2 as never },
    });
  });

  test("the latest version with its feedback is changesRequested; v10 sorts after v9", () => {
    const names = listing(
      ...Array.from({ length: 10 }, (_, i) => `v${i + 1}.md`),
      "v10.feedback.md",
    );

    expect(workspaceFromListing(DIR, names)).toEqual({
      ok: true,
      value: { ...changesRequested, version: 10 as never },
    });
  });

  test("a final directory is approved, and an empty one is an error", () => {
    expect(workspaceFromListing(FINAL, listing("v3.md"))).toEqual({
      ok: true,
      value: { kind: "approved", dir: FINAL, version: 3 as never },
    });
    expect(workspaceFromListing(FINAL, listing()).ok).toBe(false);
  });
});

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
    const memory = { kind: "approved", version: V1, dir: FINAL } as const;
    expect(workspaceOf(drafting, memory, DIR)).toEqual({
      kind: "approved",
      dir: FINAL,
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
