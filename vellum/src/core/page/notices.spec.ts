/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the workspaces here are branded values (Version, WipDir, FinalDir) written as literals: the brand is the parser's to grant, and nothing here parses. */
import { describe, expect, test } from "bun:test";

import type { PlanWorkspace } from "../protocol.ts";
import { decisionsOf, NEW_LINK_HINT_MS, noticesOf, staleEditor, statusOf } from "./notices.ts";

const WIP = "plans/2026-09-15/wip-4c2a9d93/" as never;

const drafting: PlanWorkspace = { kind: "drafting", dir: WIP, batches: 0 };

const inReview: PlanWorkspace = {
  kind: "inReview",
  dir: WIP,
  version: 1 as never,
  batches: 0,
  finalizeError: null,
};

const changesRequested: PlanWorkspace = { kind: "changesRequested", dir: WIP, version: 1 as never };

const approved: PlanWorkspace = {
  kind: "approved",
  dir: "plans/2026-09-15/offline-sync/" as never,
  version: 1 as never,
  notes: false,
};

const noop = (): void => {};

const quiet = {
  workspace: inReview,
  connection: "up" as const,
  downSince: null,
  editing: null,
  failures: [],
  undo: null,
  retry: noop,
};

function keys(input: Parameters<typeof noticesOf>[0]): string[] {
  return noticesOf(input).map((notice) => notice.key);
}

function text(input: Parameters<typeof noticesOf>[0], key: string): string {
  const notice = noticesOf(input).find((candidate) => candidate.key === key);

  if (notice === undefined) throw new Error(`no notice ${key}`);

  return notice.text.map((part) => (part instanceof Object ? `\`${part.code}\`` : part)).join("");
}

describe("noticesOf", () => {
  test("a quiet review under review has no notice", () => {
    expect(keys(quiet)).toEqual([]);
  });

  test("the connection lost comes first, and names the new link past the hint's delay", () => {
    const down = { ...quiet, connection: "down" as const, downSince: 0 };
    expect(keys({ ...down, failures: [{ op: "decision", text: "x" }] })).toEqual([
      "connection",
      "failure:decision",
    ]);
    expect(text(down, "connection")).not.toContain("/vellum:start");
    expect(text({ ...down, downSince: NEW_LINK_HINT_MS }, "connection")).toContain(
      "`/vellum:start`",
    );
  });

  test("while the connection is down the draft's failure is folded into the connection's", () => {
    const down = { ...quiet, connection: "down" as const, downSince: 0 };
    expect(keys({ ...down, failures: [{ op: "draft", text: "x" }] })).toEqual(["connection"]);
    expect(text(down, "connection")).toContain("kept in this tab");
  });

  test("a failure is one notice per operation, an alert in the words it was given", () => {
    const failed = {
      ...quiet,
      failures: [{ op: "load" as const, text: "mockup.html could not be loaded." }],
    };

    expect(noticesOf(failed)).toEqual([
      { key: "failure:load", kind: "err", text: ["mockup.html could not be loaded."] },
    ]);
  });

  test("the stale editor derives from the editor and the version, and says which case", () => {
    const editing = { version: 1 as never };
    expect(keys({ ...quiet, editing })).toEqual([]);
    const moved = { ...quiet, editing, workspace: { ...inReview, version: 2 as never } };
    expect(text(moved, "stale-editor")).toBe(
      "v2 arrived while you were editing v1. Copy what you need, then Cancel.",
    );
    expect(text({ ...quiet, editing, workspace: changesRequested }, "stale-editor")).toBe(
      "v1 is no longer under review. Copy what you need, then Cancel.",
    );
    expect(keys({ ...quiet, editing, workspace: drafting })).toEqual([]);
  });

  test("a held review draws no notice: the pill and Send feedback's title carry the reason", () => {
    // @ts-expect-error -- the core's notices take no hold: the pill, Send feedback's title and the holder's own notice say it.
    expect(keys({ ...quiet, held: "a grill is open" })).toEqual([]);
  });

  test("the workspace's own notice: a failed rename retries, a feedback waits, an approval names the folder", () => {
    const failed = { ...inReview, finalizeError: "EACCES" };
    const [notice] = noticesOf({ ...quiet, workspace: failed });

    expect(notice).toMatchObject({
      key: "finalize",
      kind: "err",
      action: { label: "Retry approval", run: noop },
    });
    expect(text({ ...quiet, workspace: failed }, "finalize")).toContain("EACCES");
    expect(noticesOf({ ...quiet, workspace: changesRequested })).toEqual([
      {
        key: "workspace",
        kind: "sent",
        text: ["Feedback sent to Claude. Waiting for the next version of the plan."],
      },
    ]);
    expect(text({ ...quiet, workspace: approved }, "workspace")).toBe(
      "Plan approved: the folder is now `plans/2026-09-15/offline-sync/`",
    );
  });

  test("a failed rename carries no Retry approval while the editor is open", () => {
    const failed = { ...inReview, finalizeError: "EACCES" };
    const editing = { ...quiet, workspace: failed, editing: { version: 1 as never } };
    const [notice] = noticesOf(editing);

    expect(notice?.key).toBe("finalize");
    expect(notice?.action).toBeUndefined();
  });

  test("while drafting, a batch sent is said until the version arrives", () => {
    expect(keys({ ...quiet, workspace: drafting })).toEqual([]);
    expect(text({ ...quiet, workspace: { ...drafting, batches: 1 } }, "workspace")).toContain(
      "sent to Claude",
    );
  });

  test("an undo is the last notice, with its action", () => {
    const undo = { label: "Undo", run: noop };
    const failed = { ...quiet, failures: [{ op: "decision" as const, text: "x" }], undo };
    expect(keys(failed)).toEqual(["failure:decision", "undo"]);
    expect(noticesOf(failed).at(-1)?.action).toBe(undo);
  });
});

describe("statusOf", () => {
  test.each([
    [drafting, null, "Drafting", "neutral"],
    [{ ...drafting, batches: 2 }, null, "Drafting · 2 sent", "neutral"],
    [inReview, null, "In review", "neutral"],
    [inReview, "a grill is open", "Held · a grill is open", "neutral"],
    [{ ...inReview, finalizeError: "EACCES" }, null, "Approval failed", "err"],
    [changesRequested, null, "Feedback sent", "sent"],
    [approved, null, "Approved", "ok"],
  ] as const)("%o held %p reads %s", (workspace, held, expectedText, tone) => {
    expect(statusOf(workspace, held)).toEqual({ text: expectedText, tone });
  });
});

describe("staleEditor", () => {
  test("no editor, or the version it opened on still under review, is not stale", () => {
    expect(staleEditor(null, inReview)).toBeNull();
    expect(staleEditor({ version: 1 as never }, inReview)).toBeNull();
    expect(staleEditor({ version: 1 as never }, null)).toBeNull();
  });
});

describe("decisionsOf", () => {
  const live = {
    workspace: inReview,
    held: null,
    connection: "up" as const,
    editing: false,
    edited: false,
    annotations: 1,
    unsentTyped: 0,
  };

  test("under review with a comment, everything is live", () => {
    expect(decisionsOf(live)).toEqual({
      approve: { disabled: false, title: null },
      notes: { disabled: false, title: null },
      feedback: { disabled: false, title: null },
    });
  });

  test("the connection lost greys all three, and says so", () => {
    const { approve, notes, feedback } = decisionsOf({ ...live, connection: "down" });
    expect([approve, notes, feedback].every((button) => button.disabled)).toBe(true);
    expect(approve.title).toMatch(/connection/iu);
    expect(feedback.title).toBe(approve.title);
  });

  test("an open editor greys all three, naming Done", () => {
    expect(decisionsOf({ ...live, editing: true }).approve.title).toMatch(/Done/u);
  });

  test("after a feedback, all three wait for the next version", () => {
    const { approve, feedback } = decisionsOf({ ...live, workspace: changesRequested });
    expect(approve.title).toMatch(/next version/iu);
    expect(feedback.title).toMatch(/next version/iu);
  });

  test("a hold greys the feedback alone, with the reason", () => {
    const { approve, feedback } = decisionsOf({ ...live, held: "a grill is open" });
    expect(approve.disabled).toBe(false);
    expect(feedback).toEqual({ disabled: true, title: "a grill is open; end it first" });
  });

  test("nothing to send greys the feedback, and names what to do, the typed text included", () => {
    expect(decisionsOf({ ...live, annotations: 0 }).feedback.title).toMatch(/comment/iu);
    expect(decisionsOf({ ...live, annotations: 0, unsentTyped: 1 }).feedback.title).toMatch(
      /Add comment/u,
    );
    expect(decisionsOf({ ...live, annotations: 0, edited: true }).feedback.disabled).toBe(false);
  });

  test("a failed rename leaves Retry approval as the one approve", () => {
    const { approve, notes } = decisionsOf({
      ...live,
      workspace: { ...inReview, finalizeError: "EACCES" },
    });

    expect(approve.disabled).toBe(true);
    expect(approve.title).toMatch(/Retry/u);
    expect(notes.disabled).toBe(true);
  });

  test("before the first load nothing is live", () => {
    expect(decisionsOf({ ...live, workspace: null }).feedback.disabled).toBe(true);
  });
});
