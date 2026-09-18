/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serverExtensions } from "../../../extensions/server.ts";
import type { ServerExtension } from "../../extension.ts";
import { parseWipDir } from "../domain/paths.ts";
import { Review } from "./review.ts";

/** The applying side: the pure decisions are covered in `domain/review.spec.ts`. */

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

const DATED = "plans/2026-09-15";

const PLAN = `# Notification settings\n\nSee [mockup](${WIP}mockup.html) and [missing](${WIP}nope.html).\n`;

const FINAL = "plans/2026-09-15/notification-settings/";

const V1 = 1 as never;

type Setup = { readonly review: Review; readonly root: string };

function setup(extensions: readonly ServerExtension[] = serverExtensions): Setup {
  const root = mkdtempSync(join(tmpdir(), "vellum-review-"));
  mkdirSync(join(root, WIP, ".review"), { recursive: true });
  writeFileSync(join(root, WIP, "mockup.html"), "<p>hi</p>");
  const workdir = parseWipDir(WIP);

  if (!workdir.ok) throw new Error(workdir.error);

  return {
    review: new Review({ project: root, workdir: workdir.value, extensions }),
    root,
  };
}

/** A review whose `plan.md` holds `plan` and was gated as v1. */
async function gated(plan = PLAN): Promise<Setup> {
  const s = setup();
  writeFileSync(join(s.root, WIP, "plan.md"), plan);
  await s.review.gate();

  return s;
}

/** A review at v2: `plan.md` gated, revised by one line, gated again. */
async function gatedTwice(): Promise<Setup> {
  const s = await gated();
  writeFileSync(join(s.root, WIP, "plan.md"), `${PLAN}more\n`);
  await s.review.gate();

  return s;
}

const EDITED = `${PLAN}edited by the reviewer\n`;

const EDITED_NOTE =
  "The reviewer edited plan.md directly (v2 → v3): keep those edits. plan.md is now v3: an item that names `.review/v3.md` gives plan.md's lines.";

const EDIT_OF_V1 = { version: V1, text: EDITED } as const;

const EDIT_OF_V2 = { version: 2 as never, text: EDITED } as const;

const GENERAL_NO = {
  id: "a",
  doc: `${WIP}.review/v1.md` as never,
  anchor: { kind: "global" },
  mark: { kind: "comment", body: "No." },
} as const;

const APPROVE = { kind: "approve", edit: null, notes: "" } as const;

const SAY_NO = { kind: "feedback", edit: null, annotations: [GENERAL_NO] } as const;

const NOTES_TITLE = "# Plan approved: the reviewer's notes";

const DRAFT = `${WIP}.review/draft.json`;

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("Review", () => {
  test("gate without plan.md answers the error the model reads", async () => {
    const { review } = setup();
    expect(await review.gate()).toEqual({ ok: false, error: `write plan.md in ${WIP} first` });
  });

  test("gate writes vN.md from plan.md and answers the version", async () => {
    const { review, root } = await gated();
    expect(read(root, `${WIP}.review/v1.md`)).toBe(PLAN);
    writeFileSync(join(root, WIP, "plan.md"), `${PLAN}more\n`);
    expect(await review.gate()).toEqual({ ok: true, version: 2 as never, kept: false });
    expect(read(root, `${WIP}.review/v2.md`)).toBe(`${PLAN}more\n`);
  });

  test("the same plan.md keeps its version under review, and reopens it after a feedback", async () => {
    const { review } = await gated();
    expect(await review.gate()).toEqual({ ok: true, version: V1, kept: true });
    await review.decide({ kind: "feedback", edit: null, annotations: [] });
    expect(await review.gate()).toEqual({ ok: true, version: 2 as never, kept: false });
    expect(await review.workspace()).toMatchObject({ kind: "inReview", version: 2 });
  });

  test("asked to keep an unchanged plan.md, the gate keeps its version after a feedback too", async () => {
    const { review } = await gated();
    await review.decide({ kind: "feedback", edit: null, annotations: [] });
    expect(await review.gate({ unchanged: "keep" })).toEqual({ ok: true, version: V1, kept: true });
    expect(await review.workspace()).toMatchObject({ kind: "changesRequested" });
    expect(await review.gate({ unchanged: "record" })).toEqual({
      ok: true,
      version: 2 as never,
      kept: false,
    });
  });

  test("feedback writes the file the pending names, and the version is decided", async () => {
    const { review, root } = await gated();
    const first = await review.decide(SAY_NO);
    expect(first).toMatchObject({ ok: true, workspace: { kind: "changesRequested" } });
    const path = `${WIP}.review/v1.feedback.md` as never;
    expect(await review.pending()).toEqual({ kind: "feedback", version: V1, path });
    expect(read(root, `${WIP}.review/v1.feedback.md`)).toContain("No.");
    expect((await review.decide(APPROVE)).ok).toBe(false);
  });

  test("feedback with an edit writes the version, plan.md and a feedback file that names both", async () => {
    const { review, root } = await gatedTwice();
    const annotations = [{ ...GENERAL_NO, doc: `${WIP}.review/v2.md` as never }];
    const result = await review.decide({ kind: "feedback", edit: EDIT_OF_V2, annotations });
    expect(result).toMatchObject({ ok: true, workspace: { kind: "changesRequested", version: 3 } });
    expect(read(root, `${WIP}.review/v3.md`)).toBe(EDITED);
    expect(read(root, `${WIP}plan.md`)).toBe(EDITED);
    expect(read(root, `${WIP}.review/v3.feedback.md`)).toBe(
      `# Plan review: changes requested (v3)\n\n${EDITED_NOTE}\n\n1. \`${WIP}.review/v3.md\`, general\n   No.\n`,
    );
  });

  test("approve with an edit leaves the edited text in the final plan.md, links rewritten", async () => {
    const { review, root } = await gated();
    const result = await review.decide({ ...APPROVE, edit: EDIT_OF_V1 });
    expect(result).toMatchObject({ ok: true, workspace: { kind: "approved", version: 2 } });
    expect(read(root, `${FINAL}plan.md`)).toEndWith("edited by the reviewer\n");
    expect(read(root, `${FINAL}plan.md`)).toContain(`${FINAL}mockup.html`);
    expect(read(root, `${FINAL}.review/v1.md`)).not.toContain("edited by the reviewer");
  });

  test("after a feedback with an edit, the gate keeps v3 for the edit and opens v4 for Claude's revision", async () => {
    const { review, root } = await gatedTwice();
    await review.decide({ kind: "feedback", edit: EDIT_OF_V2, annotations: [] });
    expect(await review.gate({ unchanged: "keep" })).toEqual({
      ok: true,
      version: 3 as never,
      kept: true,
    });
    writeFileSync(join(root, WIP, "plan.md"), `${EDITED}revised by Claude\n`);
    expect(await review.gate({ unchanged: "keep" })).toMatchObject({ version: 4, kept: false });
    expect(read(root, `${WIP}.review/v3.md`)).toBe(EDITED);
  });

  test("an approve with an edit whose rename failed is retried without the edit, and approves v2", async () => {
    const { review, root } = await gated();
    chmodSync(join(root, DATED), 0o500);
    const failed = await review.decide({ ...APPROVE, edit: EDIT_OF_V1 });
    chmodSync(join(root, DATED), 0o700);
    const stuck = { kind: "inReview", version: 2, finalizeError: expect.any(String) };
    expect(failed).toMatchObject({ ok: false, workspace: stuck });
    const retried = await review.decide(APPROVE);
    expect(retried).toMatchObject({ ok: true, workspace: { kind: "approved", version: 2 } });
    expect(read(root, `${FINAL}plan.md`)).toEndWith("edited by the reviewer\n");
    expect(read(root, `${FINAL}.review/v1.md`)).toBe(PLAN.replaceAll(WIP, FINAL));
  });

  test("approve with a note writes the notes file before the rename: the final directory holds it, links rewritten", async () => {
    const { review, root } = await gated();
    const result = await review.decide({ ...APPROVE, notes: `Start from ${WIP}mockup.html.` });
    expect(result).toMatchObject({ ok: true, workspace: { kind: "approved", notes: true } });
    expect(read(root, `${FINAL}.review/v1.notes.md`)).toBe(
      `${NOTES_TITLE} (v1)\n\nStart from ${FINAL}mockup.html.\n`,
    );
    const [dir, notes] = [FINAL as never, `${FINAL}.review/v1.notes.md` as never];
    expect(await review.pending()).toEqual({ kind: "approved", version: V1, dir, notes });
  });

  test("an approve retried after a failed rename carries no note, and still reports the first attempt's", async () => {
    const { review, root } = await gated();
    chmodSync(join(root, DATED), 0o500);
    await review.decide({ kind: "approve", edit: EDIT_OF_V1, notes: "Slice 1 only." });
    chmodSync(join(root, DATED), 0o700);
    const retried = await review.decide(APPROVE);
    expect(retried).toMatchObject({ ok: true, workspace: { version: 2, notes: true } });
    expect(read(root, `${FINAL}.review/v2.notes.md`)).toBe(
      `${NOTES_TITLE} (v2)\n\nThe reviewer edited plan.md directly (v1 → v2): read plan.md again.\n\nSlice 1 only.\n`,
    );
  });

  test("a feedback that lands deletes the draft; a refused decision keeps it", async () => {
    const { review, root } = await gated();
    writeFileSync(join(root, DRAFT), "{}");
    expect((await review.decide({ ...APPROVE, edit: EDIT_OF_V2 })).ok).toBe(false);
    expect(existsSync(join(root, DRAFT))).toBe(true);
    expect((await review.decide(SAY_NO)).ok).toBe(true);
    expect(existsSync(join(root, DRAFT))).toBe(false);
  });

  test("a feedback while drafting deletes the draft too", async () => {
    const { review, root } = setup();
    writeFileSync(join(root, DRAFT), "{}");
    await review.decide(SAY_NO);
    expect(existsSync(join(root, DRAFT))).toBe(false);
  });

  test("an approve that lands leaves no draft.json in the final directory", async () => {
    const { review, root } = await gated();
    writeFileSync(join(root, DRAFT), "{}");
    await review.decide(APPROVE);
    expect(existsSync(join(root, FINAL, ".review/v1.md"))).toBe(true);
    expect(existsSync(join(root, FINAL, ".review/draft.json"))).toBe(false);
  });

  test("approve renames the directory at once and leaves it pending with its name", async () => {
    const { review, root } = await gated();
    const result = await review.decide(APPROVE);
    expect(result).toEqual({
      ok: true,
      workspace: { kind: "approved", dir: FINAL as never, version: V1, notes: false },
    });
    expect(read(root, `${FINAL}.review/v1.md`)).toContain(`${FINAL}mockup.html`);
    const dir = FINAL as never;
    expect(await review.pending()).toEqual({ kind: "approved", version: V1, dir, notes: null });
  });

  test("approve puts the approved text back in plan.md, over a revision not submitted", async () => {
    const { review, root } = await gated();
    writeFileSync(join(root, WIP, "plan.md"), "# Notification settings\n\nrevised\n");
    await review.decide(APPROVE);
    expect(read(root, `${FINAL}plan.md`)).toBe(read(root, `${FINAL}.review/v1.md`));
    expect(read(root, `${FINAL}plan.md`)).toContain(`${FINAL}mockup.html`);
  });

  test("a rename that fails shows its error and leaves the plan under review", async () => {
    const { review, root } = await gated();
    chmodSync(join(root, DATED), 0o500);
    const result = await review.decide(APPROVE);
    chmodSync(join(root, DATED), 0o700);
    expect(result).toMatchObject({
      ok: false,
      workspace: { kind: "inReview", finalizeError: expect.any(String) },
    });
    expect(await review.pending()).toEqual({ kind: "none" });
  });

  test("view under review lists the files without the working copy of the plan", async () => {
    const { review } = await gated();
    const view = await review.view();
    expect(view.workspace.kind).toBe("inReview");
    expect(view.plan?.doc).toBe(`${WIP}.review/v1.md` as never);
    expect(view.docs).toEqual([
      { path: `${WIP}mockup.html` as never, mediaType: "text/html", modified: expect.any(Number) },
    ]);
  });

  test("view carries no previous text at v1, and v1's text at v2", async () => {
    const { review, root } = await gated();
    expect((await review.view()).plan?.previous).toBeNull();
    writeFileSync(join(root, WIP, "plan.md"), `${PLAN}more\n`);
    await review.gate();
    expect((await review.view()).plan?.previous).toEqual({ version: V1, text: PLAN });
  });

  test("view once approved lists the final directory's files, the plan's copy left out", async () => {
    const { review, root } = await gated();
    writeFileSync(join(root, WIP, "unlinked.md"), "# Unlinked\n");
    await review.decide(APPROVE);
    const view = await review.view();
    expect(view.plan?.doc).toBe(`${FINAL}.review/v1.md` as never);
    expect(view.docs.map((doc) => doc.path)).toEqual([
      `${FINAL}mockup.html` as never,
      `${FINAL}unlinked.md` as never,
    ]);
  });

  test("view while drafting lists the renderable files, the draft plan included, without .review/", async () => {
    const { review, root } = setup();
    writeFileSync(join(root, WIP, ".review", "v0.feedback-1.md"), "# Drafting feedback 1\n");
    writeFileSync(join(root, WIP, "notes.bin"), "not renderable");
    writeFileSync(join(root, WIP, "plan.md"), "# Draft\n");
    mkdirSync(join(root, WIP, "sub"));
    writeFileSync(join(root, WIP, "sub", "a.md"), "# A\n");
    const view = await review.view();
    expect(view.plan).toBeNull();
    expect(view.docs.map((doc) => doc.path)).toEqual([
      `${WIP}mockup.html` as never,
      `${WIP}plan.md` as never,
      `${WIP}sub/a.md` as never,
    ]);
  });

  test("a batch sent just before the gate is still pending after it", async () => {
    const { review, root } = setup();
    await review.decide(SAY_NO);
    writeFileSync(join(root, WIP, "plan.md"), PLAN);
    await review.gate();
    expect(await review.pending()).toEqual({
      kind: "drafts",
      batches: [{ batch: 1, path: `${WIP}.review/v0.feedback-1.md` as never }],
    });
  });

  test("a feedback while drafting writes the next batch and leaves it pending", async () => {
    const { review, root } = setup();
    const first = await review.decide(SAY_NO);
    expect(first).toMatchObject({ ok: true, workspace: { kind: "drafting", batches: 1 } });
    expect(read(root, `${WIP}.review/v0.feedback-1.md`)).toStartWith("# Drafting feedback 1");
    await review.decide(SAY_NO);
    expect(await review.pending()).toEqual({
      kind: "drafts",
      batches: [
        { batch: 1, path: `${WIP}.review/v0.feedback-1.md` as never },
        { batch: 2, path: `${WIP}.review/v0.feedback-2.md` as never },
      ],
    });
  });
});

type Holding = { reason: string | null; readonly extension: ServerExtension };

/** Holds the review while `reason` is set. */
function holding(): Holding {
  const hold: Holding = {
    reason: null,
    extension: { id: "holder", holds: () => Promise.resolve(hold.reason) },
  };

  return hold;
}

describe("a review an extension holds", () => {
  test("a gate is refused with the reason, and records no version", async () => {
    const hold = holding();
    const { review, root } = setup([hold.extension]);
    writeFileSync(join(root, WIP, "plan.md"), PLAN);
    hold.reason = "grill-2.md is open";

    expect(await review.gate()).toEqual({
      ok: false,
      error: "grill-2.md is open: the plan is submitted once the reviewer ends it",
    });
    expect(existsSync(join(root, WIP, ".review/v1.md"))).toBe(false);
  });

  test("a feedback is refused, under review and while drafting alike", async () => {
    const hold = holding();
    const { review, root } = setup([hold.extension]);
    hold.reason = "grill-1.md is open";

    expect((await review.decide(SAY_NO)).ok).toBe(false);
    hold.reason = null;
    writeFileSync(join(root, WIP, "plan.md"), PLAN);
    await review.gate();
    hold.reason = "grill-1.md is open";

    expect((await review.decide(SAY_NO)).ok).toBe(false);
    expect(existsSync(join(root, WIP, ".review/v1.feedback.md"))).toBe(false);
  });

  test("the view carries the reason, and `null` once nothing holds", async () => {
    const hold = holding();
    const { review } = setup([hold.extension]);
    hold.reason = "grill-1.md is open";

    expect((await review.view()).held).toBe("grill-1.md is open");
    hold.reason = null;

    expect((await review.view()).held).toBeNull();
  });

  test("an approval goes through, and `approved` runs after the rename, on the final directory", async () => {
    const seen: string[] = [];

    const closer: ServerExtension = {
      id: "closer",
      holds: () => Promise.resolve("grill-1.md is open"),
      approved: async (context) => void seen.push((await context.workspace()).dir),
    };

    const { review, root } = setup([closer]);
    writeFileSync(join(root, WIP, ".review/v1.md"), PLAN);

    expect((await review.decide(APPROVE)).ok).toBe(true);
    expect(seen).toEqual([FINAL]);
  });

  test("an `approved` that throws leaves the plan approved", async () => {
    const broken: ServerExtension = {
      id: "broken",
      approved: () => Promise.reject(new Error("disk full")),
    };

    const { review, root } = setup([broken]);
    writeFileSync(join(root, WIP, ".review/v1.md"), PLAN);

    expect((await review.decide(APPROVE)).workspace.kind).toBe("approved");
  });

  test("a write an extension queues during a gate lands after the version is written", async () => {
    const versionWasThere: boolean[] = [];
    let root = "";

    const opener: ServerExtension = {
      id: "opener",
      holds: (context) => {
        void context.inOrder(() => {
          versionWasThere.push(existsSync(join(root, WIP, ".review/v1.md")));

          return Promise.resolve();
        });

        return Promise.resolve(null);
      },
    };

    const made = setup([opener]);
    ({ root } = made);
    writeFileSync(join(root, WIP, "plan.md"), PLAN);
    await made.review.gate();
    await made.review.context.inOrder(() => Promise.resolve());

    expect(versionWasThere).toEqual([true]);
  });
});
