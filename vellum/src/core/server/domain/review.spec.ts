/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";

import type { Annotation } from "./feedback.ts";
import type { Draft } from "./review.ts";
import {
  decideOn,
  EMPTY_TYPED,
  editOnLoad,
  gateVersion,
  landedAnnotations,
  sendOn,
  slugFor,
} from "./review.ts";
import type { PlanWorkspace } from "./workspace.ts";

const DIR = "plans/2026-09-15/wip-4c2a9d93/" as never;

const V1 = 1 as never;

const drafting: PlanWorkspace = { kind: "drafting", dir: DIR, batches: 2 };

const inReview: PlanWorkspace = {
  kind: "inReview",
  dir: DIR,
  version: V1,
  batches: 0,
  finalizeError: null,
};

const approved: PlanWorkspace = {
  kind: "approved",
  dir: "plans/2026-09-15/notes/" as never,
  version: V1,
  notes: false,
};

describe("gateVersion", () => {
  test("the first plan is v1", () => {
    expect(gateVersion(drafting, null, "# P\n")).toEqual({ kind: "recorded", version: V1 });
  });

  test("the same text under review keeps its number", () => {
    expect(gateVersion(inReview, "# P\n", "# P\n")).toEqual({ kind: "kept", version: V1 });
  });

  test.each([
    ["the same text after a batch", { ...inReview, batches: 1 }, "# P\n"],
    ["a new text", inReview, "# Q\n"],
  ] as const)("%s is the next version", (_name, workspace, plan) => {
    expect(gateVersion(workspace, "# P\n", plan)).toEqual({
      kind: "recorded",
      version: 2 as never,
    });
  });
});

const PLAN = "# P\n";

const inReviewAt2: PlanWorkspace = { ...inReview, version: 2 as never };

const GLOBAL = { kind: "global" } as const;

const NO = { kind: "comment", body: "No." } as const;

const Q_OF_V2 = { version: 2 as never, text: "# Q\n" } as const;

function at(doc: string): Annotation {
  return { id: "a", doc: doc as never, anchor: GLOBAL, mark: NO };
}

const APPROVE = { kind: "approve", edit: null, notes: "" } as const;

const Q_OF_V1 = { version: V1, text: "# Q\n" } as const;

describe("decideOn", () => {
  test("approve names the version to finalize", () => {
    expect(decideOn(inReview, PLAN, APPROVE)).toEqual({
      kind: "approve",
      version: V1,
      edit: null,
      notes: null,
    });
  });

  test("approve with an edit is the next version, and names the version file to write", () => {
    expect(decideOn(inReview, PLAN, { ...APPROVE, edit: Q_OF_V1 })).toMatchObject({
      kind: "approve",
      version: 2,
      edit: { path: `${DIR}.review/v2.md`, text: "# Q\n" },
    });
  });

  test("an edit equal to the version's text is no edit", () => {
    expect(decideOn(inReview, PLAN, { ...APPROVE, edit: { version: V1, text: PLAN } })).toEqual({
      kind: "approve",
      version: V1,
      edit: null,
      notes: null,
    });
  });

  test("approve with an edit and a note names the new version's notes file, the edit line first", () => {
    const decided = decideOn(inReview, PLAN, {
      kind: "approve",
      edit: Q_OF_V1,
      notes: "Slice 1 only.",
    });

    expect(decided).toMatchObject({
      notes: {
        path: `${DIR}.review/v2.notes.md`,
        text: expect.stringContaining("(v1 → v2): read plan.md again.\n\nSlice 1 only.\n"),
      },
    });
  });

  test("an edit of another version than the one under review is refused", () => {
    expect(decideOn(inReview, PLAN, { ...APPROVE, edit: Q_OF_V2 })).toEqual({
      kind: "refused",
    });
  });

  test("an approve with a note is refused once approved", () => {
    expect(decideOn(approved, PLAN, { ...APPROVE, notes: "Slice 1 only." })).toEqual({
      kind: "refused",
    });
  });

  test.each([drafting, approved])("approve is refused on $kind", (workspace) => {
    expect(decideOn(workspace, PLAN, APPROVE)).toEqual({ kind: "refused" });
  });
});

function draft(annotations: readonly Annotation[], edit: Draft["edit"] = null): Draft {
  return { annotations, edit, typed: { ...EMPTY_TYPED, general: "kept" } };
}

function comment(id: string, doc = `${DIR}notes.md`): Annotation {
  return { id, doc: doc as never, anchor: GLOBAL, mark: NO };
}

describe("sendOn", () => {
  test("all sends every comment on the version under review, and leaves an empty draft", () => {
    expect(sendOn(inReview, PLAN, draft([comment("a"), comment("b")]), "all")).toEqual({
      kind: "send",
      version: V1,
      edit: null,
      editedFrom: null,
      annotations: [comment("a"), comment("b")],
      rest: { annotations: [], edit: null, typed: EMPTY_TYPED },
    });
  });

  test("while drafting the batch belongs to no version", () => {
    expect(sendOn(drafting, null, draft([comment("a")]), "all")).toMatchObject({
      kind: "send",
      version: null,
    });
  });

  test("the items named leave alone, and the draft keeps everything else", () => {
    const kept = draft([comment("a"), comment("b")], Q_OF_V1);

    expect(sendOn(inReview, PLAN, kept, [{ kind: "annotation", id: "b" }])).toEqual({
      kind: "send",
      version: V1,
      edit: null,
      editedFrom: null,
      annotations: [comment("b")],
      rest: draft([comment("a")], Q_OF_V1),
    });
  });

  test("an item the draft no longer holds sends nothing", () => {
    expect(sendOn(inReview, PLAN, draft([]), [{ kind: "annotation", id: "a" }])).toMatchObject({
      annotations: [],
    });
  });

  test("an edit goes with all, as the next version, the plan's comments retargeted to it", () => {
    const annotations = [comment("a", `${DIR}.review/v2.md`), comment("b")];

    expect(sendOn(inReviewAt2, PLAN, draft(annotations, Q_OF_V2), "all")).toMatchObject({
      version: 3,
      editedFrom: 2,
      edit: { path: `${DIR}.review/v3.md`, text: "# Q\n" },
      annotations: [comment("a", `${DIR}.review/v3.md`), comment("b")],
    });
  });

  test("an edit equal to the version's text is no edit", () => {
    const same = draft([], { version: V1, text: PLAN });

    expect(sendOn(inReview, PLAN, same, "all")).toMatchObject({ version: V1, edit: null });
  });

  test("an edit of another version, or of none, is stale", () => {
    expect(sendOn(inReview, PLAN, draft([], Q_OF_V2), "all")).toEqual({
      kind: "refused",
      reason: "stale",
    });
    expect(sendOn(drafting, null, draft([], Q_OF_V1), "all")).toEqual({
      kind: "refused",
      reason: "stale",
    });
  });

  test("nothing is sent once approved", () => {
    expect(sendOn(approved, PLAN, draft([comment("a")]), "all")).toEqual({
      kind: "refused",
      reason: "approved",
    });
  });
});

describe("editOnLoad", () => {
  const edit = { version: 2 as never, text: "# Q\n" } as const;

  test("the same version loaded again leaves the edit pending", () => {
    expect(editOnLoad(edit, { version: 2 as never, text: PLAN })).toBe("pending");
  });

  test("the next version holding the edit's own text is the edit, landed", () => {
    expect(editOnLoad(edit, { version: 3 as never, text: "# Q\n" })).toBe("landed");
  });

  test("the next version with another text, or a later one, makes the edit stale", () => {
    expect(editOnLoad(edit, { version: 3 as never, text: PLAN })).toBe("stale");
    expect(editOnLoad(edit, { version: 4 as never, text: "# Q\n" })).toBe("stale");
  });
});

describe("landedAnnotations", () => {
  test("the comments on the edited version's file move to the next version's, the others stay", () => {
    const annotations = [
      at(`${DIR}.review/v2.md`),
      at(`${DIR}.review/v1.md`),
      at(`${DIR}notes.md`),
    ];

    expect(landedAnnotations(annotations, DIR, Q_OF_V2)).toEqual([
      at(`${DIR}.review/v3.md`),
      at(`${DIR}.review/v1.md`),
      at(`${DIR}notes.md`),
    ]);
  });
});

describe("slugFor", () => {
  test("the title first, the plan file's name without one", () => {
    expect(slugFor("# Notes\n")).toEqual({ ok: true, value: "notes" as never });
    expect(slugFor("no heading")).toEqual({ ok: true, value: "plan" as never });
  });
});
