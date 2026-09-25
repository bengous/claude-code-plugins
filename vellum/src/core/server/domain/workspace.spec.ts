/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";

import type { PlanWorkspace } from "./workspace.ts";
import {
  batchFile,
  batchOf,
  takesComments,
  workspaceFromListing,
  workspaceOf,
} from "./workspace.ts";

const DIR = "plans/2026-09-15/wip-4c2a9d93/" as never;

const FINAL = "plans/2026-09-15/notification/" as never;

const V1 = 1 as never;

const drafting: PlanWorkspace = { kind: "drafting", dir: DIR, batches: 0 };

const inReview: PlanWorkspace = {
  kind: "inReview",
  dir: DIR,
  version: V1,
  batches: 0,
  finalizeError: null,
};

const approved: PlanWorkspace = { kind: "approved", dir: FINAL, version: V1, notes: false };

function listing(...names: string[]): ReadonlySet<string> {
  return new Set(names);
}

describe("workspaceFromListing", () => {
  test("no version is drafting, and the drafting feedback files are counted", () => {
    expect(workspaceFromListing(DIR, listing())).toEqual({ ok: true, value: drafting });

    expect(workspaceFromListing(DIR, listing("v0.feedback-1.md", "v0.feedback-2.md"))).toEqual({
      ok: true,
      value: { ...drafting, batches: 2 },
    });
  });

  test("the latest version is inReview, and the batches sent on it are counted, no other version's", () => {
    const names = listing("v0.feedback-1.md", "v1.md", "v1.feedback-1.md", "v2.md");

    expect(workspaceFromListing(DIR, names)).toEqual({
      ok: true,
      value: { ...inReview, version: 2 as never, batches: 0 },
    });
  });

  test("a batch sent on the version under review leaves it in review; v10 sorts after v9", () => {
    const names = listing(
      ...Array.from({ length: 10 }, (_, i) => `v${i + 1}.md`),
      "v10.feedback-1.md",
      "v10.feedback-2.md",
    );

    expect(workspaceFromListing(DIR, names)).toEqual({
      ok: true,
      value: { ...inReview, version: 10 as never, batches: 2 },
    });
  });

  test("a feedback file with no batch number is no batch", () => {
    expect(workspaceFromListing(DIR, listing("v1.md", "v1.feedback.md"))).toEqual({
      ok: true,
      value: inReview,
    });
  });

  test("a final directory is approved, and an empty one is an error", () => {
    expect(workspaceFromListing(FINAL, listing("v3.md"))).toEqual({
      ok: true,
      value: { kind: "approved", dir: FINAL, version: 3 as never, notes: false },
    });
    expect(workspaceFromListing(FINAL, listing()).ok).toBe(false);
  });

  test("a final directory with the approved version's notes file says so; an earlier version's does not count", () => {
    const noted = listing("v2.md", "v2.notes.md", "v3.md", "v3.notes.md");
    expect(workspaceFromListing(FINAL, noted)).toMatchObject({
      value: { version: 3, notes: true },
    });
    const earlier = listing("v2.md", "v2.notes.md", "v3.md");
    expect(workspaceFromListing(FINAL, earlier)).toMatchObject({
      value: { version: 3, notes: false },
    });
  });
});

describe("workspaceOf", () => {
  test.each([
    ["none", { kind: "none" }, inReview],
    [
      "finalizeError",
      { kind: "finalizeError", version: V1, error: "EACCES" },
      { ...inReview, finalizeError: "EACCES" },
    ],
  ] as const)("overlays %s on a plan under review", (_name, memory, expected) => {
    expect(workspaceOf(inReview, memory)).toEqual(expected);
  });

  test("the approved memory wins over the directory, which was renamed", () => {
    const memory = { kind: "approved", version: V1, dir: FINAL, notes: true } as const;
    expect(workspaceOf(drafting, memory)).toEqual({
      kind: "approved",
      dir: FINAL,
      version: V1,
      notes: true,
    });
  });
});

describe("takesComments", () => {
  test.each([drafting, inReview])("comments are taken on $kind", (workspace) => {
    expect(takesComments(workspace)).toBe(true);
  });

  test("no comment is taken once approved", () => {
    expect(takesComments(approved)).toBe(false);
  });
});

describe("a batch's file", () => {
  test("is numbered under the version it was sent on, v0 before the first", () => {
    expect(batchFile(null, 1)).toBe(".review/v0.feedback-1.md");
    expect(batchFile(V1, 2)).toBe(".review/v1.feedback-2.md");
  });

  test("its name says the version and the batch, and no other name is one", () => {
    expect(batchOf("v12.feedback-3.md")).toEqual({ version: 12, batch: 3 });
    expect(batchOf("v0.feedback-1.md")).toEqual({ version: 0, batch: 1 });
    const names = ["v1.feedback.md", "v1.feedback-0.md", "v1.md", "draft.json"];

    expect(names.map((name) => batchOf(name))).toEqual([null, null, null, null]);
  });
});
