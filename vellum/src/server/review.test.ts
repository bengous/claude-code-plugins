/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serverPlugins } from "../../plugins/server.ts";
import type { WipDir } from "../workspace/paths.ts";
import { parseWipDir } from "../workspace/paths.ts";
import { Review } from "./review.ts";

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

const PLAN = `# Notification settings\n\nSee [mockup](${WIP}mockup.html) and [missing](${WIP}nope.html).\n`;

type Setup = { readonly review: Review; readonly root: string; readonly workdir: WipDir };

function setup(): Setup {
  const root = mkdtempSync(join(tmpdir(), "vellum-review-"));
  mkdirSync(join(root, WIP, ".review"), { recursive: true });
  writeFileSync(join(root, WIP, "mockup.html"), "<p>hi</p>");
  const workdir = parseWipDir(WIP);

  if (!workdir.ok) throw new Error(workdir.error);

  return {
    review: new Review({ project: root, workdir: workdir.value, plugins: serverPlugins }),
    root,
    workdir: workdir.value,
  };
}

describe("Review", () => {
  test("gate writes v1, the same text keeps v1, a new text makes v2", async () => {
    const { review, root } = setup();
    expect(await review.gate({ plan: PLAN, planFilePath: "plans/p.md" })).toBe(1 as never);
    expect(await review.gate({ plan: PLAN, planFilePath: "plans/p.md" })).toBe(1 as never);
    expect(await review.gate({ plan: `${PLAN}more\n`, planFilePath: "plans/p.md" })).toBe(
      2 as never,
    );
    expect(readFileSync(join(root, WIP, ".review/v2.md"), "utf8")).toBe(`${PLAN}more\n`);
  });

  test("the same text after a feedback is a new version, and the old pending is gone", async () => {
    const { review } = setup();
    await review.gate({ plan: PLAN, planFilePath: "plans/p.md" });
    await review.decide({ kind: "feedback", annotations: [] });
    expect(review.pendingNow().kind).toBe("feedback");
    expect(await review.gate({ plan: PLAN, planFilePath: "plans/p.md" })).toBe(2 as never);
    expect(review.pendingNow()).toEqual({ kind: "none" });
    expect((await review.workspace()).kind).toBe("inReview");
  });

  test("a failed finalize clears the pending approval until the reviewer retries", async () => {
    const { review } = setup();
    await review.gate({ plan: "???\n", planFilePath: "plans/???.md" });
    await review.decide({ kind: "approve" });
    const result = await review.finalize(1 as never);
    expect(result.ok).toBe(false);
    expect(result.workspace).toMatchObject({ kind: "inReview", finalizeError: expect.any(String) });
    expect(review.pendingNow()).toEqual({ kind: "none" });
    expect((await review.decide({ kind: "approve" })).workspace.kind).toBe("approvedPending");
  });

  test("view lists the plan and the linked docs that exist", async () => {
    const { review } = setup();
    await review.gate({ plan: PLAN, planFilePath: "plans/p.md" });
    const view = await review.view();
    expect(view.workspace.kind).toBe("inReview");
    expect(view.plan?.doc).toBe(`${WIP}.review/v1.md` as never);
    expect(view.docs).toEqual([{ path: `${WIP}mockup.html` as never, mediaType: "text/html" }]);
  });

  test("feedback writes the file, sets pending, and a second decision is refused", async () => {
    const { review, root } = setup();
    await review.gate({ plan: PLAN, planFilePath: "plans/p.md" });

    const first = await review.decide({
      kind: "feedback",
      annotations: [
        { id: "a", doc: `${WIP}.review/v1.md` as never, anchor: { kind: "global" }, body: "No." },
      ],
    });

    expect(first.ok).toBe(true);
    expect(first.workspace.kind).toBe("changesRequested");
    expect(readFileSync(join(root, WIP, ".review/v1.feedback.md"), "utf8")).toContain("No.");
    expect(review.pendingNow()).toEqual({
      kind: "feedback",
      version: 1 as never,
      path: `${WIP}.review/v1.feedback.md` as never,
    });
    expect((await review.decide({ kind: "approve" })).ok).toBe(false);
  });

  test("approve then finalize renames the directory and rewrites the plan's links", async () => {
    const { review, root } = setup();
    await review.gate({ plan: PLAN, planFilePath: "plans/p.md" });
    const decided = await review.decide({ kind: "approve" });
    expect(decided.workspace.kind).toBe("approvedPending");
    expect(review.pendingNow()).toEqual({ kind: "approved", version: 1 as never });

    const result = await review.finalize(1 as never);

    if (!result.ok) throw new Error("finalize failed");
    expect(result.workspace).toEqual({
      kind: "approved",
      dir: "plans/2026-09-15/notification-settings/" as never,
      version: 1 as never,
    });
    expect(result.plan).toContain("plans/2026-09-15/notification-settings/mockup.html");
    expect(
      readFileSync(join(root, "plans/2026-09-15/notification-settings/.review/v1.md"), "utf8"),
    ).toBe(result.plan);
    expect((await review.view()).plan?.text).toBe(result.plan);
  });

  test("finalize without an approval is refused and leaves the review open", async () => {
    const { review } = setup();
    await review.gate({ plan: PLAN, planFilePath: "plans/p.md" });
    const result = await review.finalize(1 as never);
    expect(result.ok).toBe(false);
    expect(result.workspace.kind).toBe("inReview");
  });

  test("a plan without a heading takes the plan file's name", async () => {
    const { review } = setup();
    await review.gate({ plan: "no heading\n", planFilePath: "plans/plan-quiet-otter.md" });
    await review.decide({ kind: "approve" });
    const result = await review.finalize(1 as never);
    expect(result.ok).toBe(true);
    expect(result.workspace).toMatchObject({ dir: "plans/2026-09-15/plan-quiet-otter/" });
  });
});
