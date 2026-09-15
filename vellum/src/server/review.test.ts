/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serverPlugins } from "../../plugins/server.ts";
import { parseWipDir } from "../workspace/paths.ts";
import { Review } from "./review.ts";

/** The applying side: the pure decisions are covered in `transitions.test.ts`. */

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

const PLAN = `# Notification settings\n\nSee [mockup](${WIP}mockup.html) and [missing](${WIP}nope.html).\n`;

const FINAL = "plans/2026-09-15/notification-settings/";

const V1 = 1 as never;

type Setup = { readonly review: Review; readonly root: string };

function setup(): Setup {
  const root = mkdtempSync(join(tmpdir(), "vellum-review-"));
  mkdirSync(join(root, WIP, ".review"), { recursive: true });
  writeFileSync(join(root, WIP, "mockup.html"), "<p>hi</p>");
  const workdir = parseWipDir(WIP);

  if (!workdir.ok) throw new Error(workdir.error);

  return {
    review: new Review({ project: root, workdir: workdir.value, plugins: serverPlugins }),
    root,
  };
}

/** A review with `plan` gated as v1. */
async function gated(plan = PLAN, planFilePath = "plans/p.md"): Promise<Setup> {
  const s = setup();
  await s.review.gate({ plan, planFilePath });

  return s;
}

const GENERAL_NO = {
  id: "a",
  doc: `${WIP}.review/v1.md` as never,
  anchor: { kind: "global" },
  body: "No.",
} as const;

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("Review", () => {
  test("gate writes vN.md and answers the version", async () => {
    const { review, root } = await gated();
    expect(await review.gate({ plan: `${PLAN}more\n`, planFilePath: "plans/p.md" })).toBe(
      2 as never,
    );
    expect(read(root, `${WIP}.review/v2.md`)).toBe(`${PLAN}more\n`);
  });

  test("feedback writes the file the pending names, and the version is decided", async () => {
    const { review, root } = await gated();
    const first = await review.decide({ kind: "feedback", annotations: [GENERAL_NO] });
    expect(first).toMatchObject({ ok: true, workspace: { kind: "changesRequested" } });
    const path = `${WIP}.review/v1.feedback.md` as never;
    expect(await review.pending()).toEqual({ kind: "feedback", version: V1, path });
    expect(read(root, `${WIP}.review/v1.feedback.md`)).toContain("No.");
    expect((await review.decide({ kind: "approve" })).ok).toBe(false);
  });

  test("the same text after a feedback opens a new round, and nothing is pending", async () => {
    const { review } = await gated();
    await review.decide({ kind: "feedback", annotations: [] });
    expect(await review.gate({ plan: PLAN, planFilePath: "plans/p.md" })).toBe(2 as never);
    expect(await review.pending()).toEqual({ kind: "none" });
  });

  test("approve then finalize renames the directory and rewrites the plan's links", async () => {
    const { review, root } = await gated();
    await review.decide({ kind: "approve" });
    expect(await review.pending()).toEqual({ kind: "approved", version: V1 });
    const result = await review.finalize(V1);

    if (!result.ok) throw new Error("finalize failed");
    expect(result.workspace).toEqual({ kind: "approved", dir: FINAL as never, version: V1 });
    expect(result.plan).toContain(`${FINAL}mockup.html`);
    expect(read(root, `${FINAL}.review/v1.md`)).toBe(result.plan);
    expect((await review.view()).plan?.text).toBe(result.plan);
  });

  test("finalize is refused without an approval", async () => {
    const { review } = await gated();
    expect(await review.finalize(V1)).toMatchObject({ ok: false, workspace: { kind: "inReview" } });
  });

  test("a failed finalize shows its error, leaves nothing pending, and takes a retry", async () => {
    const { review } = await gated("???\n", "plans/???.md");
    await review.decide({ kind: "approve" });
    const result = await review.finalize(V1);
    expect(result).toMatchObject({
      ok: false,
      workspace: { kind: "inReview", finalizeError: expect.any(String) },
    });
    expect(await review.pending()).toEqual({ kind: "none" });
    expect((await review.decide({ kind: "approve" })).workspace.kind).toBe("approvedPending");
  });

  test("view lists the plan and the linked docs that exist", async () => {
    const { review } = await gated();
    const view = await review.view();
    expect(view.workspace.kind).toBe("inReview");
    expect(view.plan?.doc).toBe(`${WIP}.review/v1.md` as never);
    expect(view.docs).toEqual([{ path: `${WIP}mockup.html` as never, mediaType: "text/html" }]);
  });
});
