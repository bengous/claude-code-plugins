/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serverExtensions } from "../../../extensions/server.ts";
import type { ServerExtension } from "../../extension.ts";
import { parseWipDir } from "../domain/paths.ts";
import type { Draft, SendRequest } from "../domain/review.ts";
import { choicesIn, EMPTY_TYPED } from "../domain/review.ts";
import type { SendResult } from "./review.ts";
import { Review } from "./review.ts";

/** The applying side: the pure decisions are covered in `domain/review.spec.ts`. */

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

const ARTICLE = { heading: "Layout", role: "article", name: "", openingTag: "<article>" };

const DATED = "plans/2026-09-15";

const PLAN = `# Notification settings\n\nSee [mockup](${WIP}mockup.html) and [missing](${WIP}nope.html).\n`;

const FINAL = "plans/2026-09-15/notification-settings/";

const V1 = 1 as never;

type Setup = { readonly review: Review; readonly root: string };

/** A held rename is retried this long here, so a test that holds the folder to the end stays under bun's 5 s. */
const HELD_SHORT_MS = 200;

const WINDOWS = process.platform === "win32";

function setup(
  extensions: readonly ServerExtension[] = serverExtensions,
  heldRetryMs = HELD_SHORT_MS,
): Setup {
  const root = mkdtempSync(join(tmpdir(), "vellum-review-"));
  mkdirSync(join(root, WIP, ".review"), { recursive: true });
  writeFileSync(join(root, WIP, "mockup.html"), "<p>hi</p>");
  const workdir = parseWipDir(WIP);

  if (!workdir.ok) throw new Error(workdir.error);

  return {
    review: new Review({ project: root, workdir: workdir.value, extensions, heldRetryMs }),
    root,
  };
}

/** The error of a rename `refuseRename` made fail, not of any other step of `finalize`. */
const RENAME_FAILED = expect.stringMatching(/^rename /u);

/**
 * Makes the working directory's rename fail until the call it answers: a dated folder nobody may
 * write on POSIX; on Windows, which reads no folder's mode, a file of the directory held open.
 */
function refuseRename(root: string): () => void {
  if (process.platform !== "win32") {
    chmodSync(join(root, DATED), 0o500);

    return () => chmodSync(join(root, DATED), 0o700);
  }

  const held = openSync(join(root, WIP, "mockup.html"), "r");

  return () => closeSync(held);
}

/** Every entry the channel holds, from where the review lives now. */
async function told(review: Review): Promise<readonly unknown[]> {
  return (await review.channel(0)).map(({ entry }) => entry);
}

/** A review whose `plan.md` holds `plan` and was gated as v1. */
async function gated(plan = PLAN, heldRetryMs = HELD_SHORT_MS): Promise<Setup> {
  const s = setup(serverExtensions, heldRetryMs);
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

const NOTES_TITLE = "# Plan approved: the reviewer's notes";

const DRAFT = `${WIP}.review/draft.json`;

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/**
 * The page's draft as `PUT /api/draft` stores it, then a Send of it as the bar asks it: every
 * comment on screen and the edit, with the extensions' parts, unless `request` says otherwise.
 */
function send(
  s: Setup,
  draft: Partial<Draft>,
  request: Partial<SendRequest> = {},
): Promise<SendResult> {
  const stored: Draft = { annotations: [], edit: null, choices: {}, typed: EMPTY_TYPED, ...draft };
  writeFileSync(join(s.root, DRAFT), JSON.stringify(stored));

  return s.review.send({
    annotations: stored.annotations.map(({ id }) => id),
    edit: stored.edit?.version ?? null,
    choices: choicesIn(stored.choices),
    parts: true,
    takeDefaults: [],
    ...request,
  });
}

/** Send now: the one comment named, no part. */
const SEND_NOW = { annotations: ["b"], edit: null, choices: [], parts: false } as const;

const SAY_NO: Partial<Draft> = { annotations: [GENERAL_NO] };

const ANOTHER = { ...GENERAL_NO, id: "b", mark: { kind: "comment", body: "Nor this." } } as const;

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

  test("the same plan.md keeps its version under review, and reopens it after a batch", async () => {
    const s = await gated();
    expect(await s.review.gate()).toEqual({ ok: true, version: V1, kept: true });
    await send(s, SAY_NO);
    expect(await s.review.gate()).toEqual({ ok: true, version: 2 as never, kept: false });
    expect(await s.review.workspace()).toMatchObject({ kind: "inReview", version: 2, batches: 0 });
  });

  test("asked to keep an unchanged plan.md, the gate keeps its version after a batch too", async () => {
    const s = await gated();
    await send(s, SAY_NO);
    expect(await s.review.gate({ unchanged: "keep" })).toEqual({
      ok: true,
      version: V1,
      kept: true,
    });
    expect(await s.review.gate({ unchanged: "record" })).toEqual({
      ok: true,
      version: 2 as never,
      kept: false,
    });
  });

  test("a Send writes its batch and tells the channel, and the version stays under review", async () => {
    const s = await gated();
    const file = `${WIP}.review/v1.feedback-1.md`;
    expect(await send(s, SAY_NO)).toEqual({ ok: true, file: file as never, seq: 1 });
    expect(await s.review.workspace()).toMatchObject({ kind: "inReview", version: 1, batches: 1 });
    expect(await told(s.review)).toEqual([{ kind: "sent", file }]);
    expect(read(s.root, file)).toContain("No.");
  });

  test("two Sends on one version are two batches, and the version can still be approved", async () => {
    const s = await gated();
    await send(s, SAY_NO);
    await send(s, { annotations: [ANOTHER] });
    expect(await told(s.review)).toEqual([
      { kind: "sent", file: `${WIP}.review/v1.feedback-1.md` },
      { kind: "sent", file: `${WIP}.review/v1.feedback-2.md` },
    ]);
    expect(read(s.root, `${WIP}.review/v1.feedback-2.md`)).toContain("Nor this.");
    expect((await s.review.decide(APPROVE)).ok).toBe(true);
  });

  test("a Send with an edit writes the version, plan.md and a batch on it that names both", async () => {
    const s = await gatedTwice();
    const annotations = [{ ...GENERAL_NO, doc: `${WIP}.review/v2.md` as never }];
    await send(s, { annotations, edit: EDIT_OF_V2 });
    expect(await s.review.workspace()).toMatchObject({ kind: "inReview", version: 3, batches: 1 });
    expect(read(s.root, `${WIP}.review/v3.md`)).toBe(EDITED);
    expect(read(s.root, `${WIP}plan.md`)).toBe(EDITED);
    expect(read(s.root, `${WIP}.review/v3.feedback-1.md`)).toBe(
      `# Plan review: batch 1 on v3\n\n${EDITED_NOTE}\n\n## Comments\n\n1. \`${WIP}.review/v3.md\`, general\n   No.\n`,
    );
  });

  test("Send now takes the comment named, and the draft keeps the rest", async () => {
    const s = await gated();
    const other = { ...ANOTHER, doc: `${WIP}notes.md` as never };
    await send(s, { annotations: [GENERAL_NO, other], edit: EDIT_OF_V1 }, SEND_NOW);
    expect(read(s.root, `${WIP}.review/v1.feedback-1.md`)).toContain("Nor this.");
    expect(read(s.root, `${WIP}.review/v1.feedback-1.md`)).not.toContain("No.");
    expect(JSON.parse(read(s.root, DRAFT))).toMatchObject({
      annotations: [GENERAL_NO],
      edit: EDIT_OF_V1,
    });
  });

  test("a comment named that the draft no longer holds refuses the Send, and nothing is written", async () => {
    const s = await gated();
    expect(await send(s, SAY_NO, { annotations: ["a", "gone"] })).toEqual({
      ok: false,
      refusal: { reason: "changed" },
    });
    expect(await told(s.review)).toEqual([]);
  });

  test("a Send with nothing in it is refused and writes nothing", async () => {
    const s = await gated();
    expect(await send(s, {})).toEqual({ ok: false, refusal: { reason: "empty" } });
    expect(await told(s.review)).toEqual([]);
  });

  test("a Send is refused once approved, and on a draft it cannot read", async () => {
    const s = await gated();

    const all: SendRequest = {
      annotations: [],
      edit: null,
      choices: [],
      parts: true,
      takeDefaults: [],
    };

    writeFileSync(join(s.root, DRAFT), '{"annotations":3}');
    expect(await s.review.send(all)).toEqual({ ok: false, refusal: { reason: "unreadable" } });
    await s.review.decide(APPROVE);
    expect(await s.review.send(all)).toEqual({ ok: false, refusal: { reason: "approved" } });
  });

  test("approve with an edit leaves the edited text in the final plan.md, links rewritten", async () => {
    const { review, root } = await gated();
    const result = await review.decide({ ...APPROVE, edit: EDIT_OF_V1 });
    expect(result).toMatchObject({ ok: true, workspace: { kind: "approved", version: 2 } });
    expect(read(root, `${FINAL}plan.md`)).toEndWith("edited by the reviewer\n");
    expect(read(root, `${FINAL}plan.md`)).toContain(`${FINAL}mockup.html`);
    expect(read(root, `${FINAL}.review/v1.md`)).not.toContain("edited by the reviewer");
  });

  test("after a Send with an edit, the gate keeps v3 for the edit and opens v4 for Claude's revision", async () => {
    const s = await gatedTwice();
    await send(s, { edit: EDIT_OF_V2 });
    expect(await s.review.gate({ unchanged: "keep" })).toEqual({
      ok: true,
      version: 3 as never,
      kept: true,
    });
    writeFileSync(join(s.root, WIP, "plan.md"), `${EDITED}revised by Claude\n`);
    expect(await s.review.gate({ unchanged: "keep" })).toMatchObject({ version: 4, kept: false });
    expect(read(s.root, `${WIP}.review/v3.md`)).toBe(EDITED);
  });

  test("an approve with an edit whose rename failed is retried without the edit, and approves v2", async () => {
    const { review, root } = await gated();
    const release = refuseRename(root);
    const failed = await review.decide({ ...APPROVE, edit: EDIT_OF_V1 });
    release();
    const stuck = { kind: "inReview", version: 2, finalizeError: RENAME_FAILED };
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
    const notes = `${FINAL}.review/v1.notes.md`;
    expect(await told(review)).toEqual([{ kind: "approved", version: 1, dir: FINAL, notes }]);
  });

  test("an approve retried after a failed rename carries no note, and still reports the first attempt's", async () => {
    const { review, root } = await gated();
    const release = refuseRename(root);
    await review.decide({ kind: "approve", edit: EDIT_OF_V1, notes: "Slice 1 only." });
    release();
    const retried = await review.decide(APPROVE);
    expect(retried).toMatchObject({ ok: true, workspace: { version: 2, notes: true } });
    expect(read(root, `${FINAL}.review/v2.notes.md`)).toBe(
      `${NOTES_TITLE} (v2)\n\nThe reviewer edited plan.md directly (v1 → v2): read plan.md again.\n\nSlice 1 only.\n`,
    );
  });

  test("a Send that lands deletes the draft; a refused one keeps it", async () => {
    const s = await gated();
    expect(await send(s, { ...SAY_NO, edit: EDIT_OF_V2 })).toMatchObject({ ok: false });
    expect(existsSync(join(s.root, DRAFT))).toBe(true);
    expect((await send(s, SAY_NO)).ok).toBe(true);
    expect(existsSync(join(s.root, DRAFT))).toBe(false);
  });

  test("a Send while drafting deletes the draft too", async () => {
    const s = setup();
    await send(s, SAY_NO);
    expect(existsSync(join(s.root, DRAFT))).toBe(false);
  });

  test("an approve that lands leaves no draft.json in the final directory", async () => {
    const { review, root } = await gated();
    writeFileSync(join(root, DRAFT), "{}");
    await review.decide(APPROVE);
    expect(existsSync(join(root, FINAL, ".review/v1.md"))).toBe(true);
    expect(existsSync(join(root, FINAL, ".review/draft.json"))).toBe(false);
  });

  test("approve renames the directory at once and tells the channel, moved with it, its name", async () => {
    const { review, root } = await gated();
    const result = await review.decide(APPROVE);
    expect(result).toEqual({
      ok: true,
      workspace: { kind: "approved", dir: FINAL as never, version: V1, notes: false },
    });
    expect(read(root, `${FINAL}.review/v1.md`)).toContain(`${FINAL}mockup.html`);
    expect(await told(review)).toEqual([{ kind: "approved", version: 1, dir: FINAL, notes: null }]);
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
    const release = refuseRename(root);
    const result = await review.decide(APPROVE);
    release();
    expect(result).toMatchObject({
      ok: false,
      workspace: { kind: "inReview", finalizeError: RENAME_FAILED },
    });
    expect(await told(review)).toEqual([]);
  });

  test.if(WINDOWS)(
    "a rename refused while a program holds the folder is retried, and approves once it lets go",
    async () => {
      const { review, root } = await gated(PLAN, 2_000);
      const release = refuseRename(root);
      setTimeout(release, 300);
      const result = await review.decide(APPROVE);
      expect(result).toMatchObject({ ok: true, workspace: { kind: "approved", dir: FINAL } });
    },
  );

  test.if(WINDOWS)(
    "a folder held past the retries names what may hold it, and Retry approval",
    async () => {
      const { review, root } = await gated();
      const release = refuseRename(root);
      const result = await review.decide(APPROVE);
      release();
      const held = `rename ${WIP} → ${FINAL} failed: a program holds ${WIP} (a terminal, File Explorer, an editor or a background command open in it); close it, then Retry approval`;
      expect(result).toMatchObject({ ok: false, workspace: { finalizeError: held } });
    },
  );

  test("view under review lists the files without the working copy of the plan", async () => {
    const { review } = await gated();
    const view = await review.view();
    expect(view.workspace.kind).toBe("inReview");
    expect(view.plan?.doc).toBe(`${WIP}.review/v1.md` as never);
    expect(view.docs).toEqual([
      {
        path: `${WIP}mockup.html` as never,
        mediaType: "text/html",
        modified: expect.any(Number),
        group: "artifact",
      },
    ]);
  });

  test("view under review groups a file the plan links outside its directory as cited", async () => {
    const s = setup();
    mkdirSync(join(s.root, "docs"));
    writeFileSync(join(s.root, "docs", "guide.md"), "# Guide\n");
    writeFileSync(join(s.root, WIP, "plan.md"), "# Plan\n\nSee [guide](docs/guide.md).\n");
    await s.review.gate();
    const view = await s.review.view();
    expect(view.docs.map((doc) => [doc.path, doc.group])).toEqual([
      [`${WIP}mockup.html` as never, "artifact"],
      ["docs/guide.md" as never, "cited"],
    ]);
  });

  test("a plan under review that writes `plan.md` does not bring its working copy back", async () => {
    const { review } = await gated("# Plan\n\nThe working copy is `plan.md`.\n");
    const view = await review.view();
    expect(view.docs.map((doc) => doc.path)).toEqual([`${WIP}mockup.html` as never]);
  });

  test("view names the working copy the version was taken from, renamed once approved", async () => {
    const { review } = await gated();
    expect((await review.view()).plan?.workingCopy).toBe(`${WIP}plan.md` as never);
    await review.decide(APPROVE);
    expect((await review.view()).plan?.workingCopy).toBe(`${FINAL}plan.md` as never);
  });

  test("a plan under review that names a version file does not list it as cited", async () => {
    const s = await gated("# Plan\n\nAs in `.review/v1.md`.\n");
    writeFileSync(join(s.root, WIP, "plan.md"), "# Plan\n\nStill as in `.review/v1.md`.\n");
    await s.review.gate();
    const view = await s.review.view();
    expect(view.plan?.doc).toBe(`${WIP}.review/v2.md` as never);
    expect(view.docs.map((doc) => doc.path)).toEqual([`${WIP}mockup.html` as never]);
  });

  test("a cited file whose own name holds .review is listed: the segment is what counts", async () => {
    const s = setup();
    mkdirSync(join(s.root, "docs"));
    writeFileSync(join(s.root, "docs", "notes.review.md"), "# Notes\n");
    writeFileSync(join(s.root, WIP, "plan.md"), "# Plan\n\nSee [notes](docs/notes.review.md).\n");
    await s.review.gate();
    const view = await s.review.view();
    expect(view.docs.map((doc) => doc.path)).toEqual([
      `${WIP}mockup.html` as never,
      "docs/notes.review.md" as never,
    ]);
  });

  test("a plan that names a batch does not list it as cited", async () => {
    const s = await gated("# Plan\n\nThe answer is in `.review/v1.feedback-1.md`.\n");
    writeFileSync(join(s.root, WIP, ".review", "v1.feedback-1.md"), "# Changes\n");
    const view = await s.review.view();
    expect(view.workspace).toMatchObject({ kind: "inReview", batches: 1 });
    expect(view.docs.map((doc) => doc.path)).toEqual([`${WIP}mockup.html` as never]);
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
      `${WIP}plan.md` as never,
      `${WIP}mockup.html` as never,
      `${WIP}sub/a.md` as never,
    ]);
  });

  test("view while drafting groups plan.md as the plan, and the rest as artifacts", async () => {
    const { review, root } = setup();
    writeFileSync(join(root, WIP, "plan.md"), "# Draft\n");
    const view = await review.view();
    expect(view.docs.map((doc) => [doc.path, doc.group])).toEqual([
      [`${WIP}plan.md` as never, "plan"],
      [`${WIP}mockup.html` as never, "artifact"],
    ]);
  });

  test("a batch sent just before the gate is told once, and the gate tells nothing", async () => {
    const s = setup();
    await send(s, SAY_NO);
    writeFileSync(join(s.root, WIP, "plan.md"), PLAN);
    await s.review.gate();
    expect(await told(s.review)).toEqual([
      { kind: "sent", file: `${WIP}.review/v0.feedback-1.md` },
    ]);
  });

  test("each Send while drafting writes the next batch, and is an entry of its own", async () => {
    const s = setup();
    await send(s, SAY_NO);
    expect(await s.review.workspace()).toMatchObject({ kind: "drafting", batches: 1 });
    expect(read(s.root, `${WIP}.review/v0.feedback-1.md`)).toStartWith("# Drafting feedback 1");
    await send(s, SAY_NO);
    expect(await told(s.review)).toEqual([
      { kind: "sent", file: `${WIP}.review/v0.feedback-1.md` },
      { kind: "sent", file: `${WIP}.review/v0.feedback-2.md` },
    ]);
  });
});

/** An extension with a round open, and each batch its part's commit heard. */
type Rounding = { readonly extension: ServerExtension; readonly heard: unknown[] };

/** `untyped` questions no answer takes, which a Send leaves to their recommendation once agreed. */
function rounding(untyped: readonly string[] = []): Rounding {
  const heard: unknown[] = [];

  return {
    heard,
    extension: {
      id: "round",
      part: (_, __, takeDefaults) =>
        Promise.resolve(
          untyped.every((id) => takeDefaults.includes(id))
            ? {
                kind: "part",
                text: "## Round\n\nReviewer: Q1: yes",
                typed: (typed) => ({ ...typed, general: "" }),
                commit: (batch) => {
                  heard.push(batch);

                  return Promise.resolve();
                },
              }
            : { kind: "unanswered", ids: untyped },
        ),
    },
  };
}

describe("a Send and the extensions", () => {
  test("questions no answer takes refuse the Send, with their ids, until the reviewer agrees to those", async () => {
    const round = rounding(["Q2", "Q3"]);
    const s = setup([round.extension]);
    expect(await send(s, SAY_NO)).toEqual({
      ok: false,
      refusal: { reason: "unanswered", ids: ["Q2", "Q3"] },
    });
    expect(await send(s, SAY_NO, { takeDefaults: ["Q2"] })).toMatchObject({ ok: false });
    expect(await told(s.review)).toEqual([]);
    expect((await send(s, SAY_NO, { takeDefaults: ["Q2", "Q3"] })).ok).toBe(true);
  });

  test("an extension's part comes before the comments, and its commit hears the file and its number once written", async () => {
    const round = rounding();
    const s = setup([round.extension]);
    await send(s, SAY_NO);
    const file = `${WIP}.review/v0.feedback-1.md`;
    expect(read(s.root, file)).toBe(
      `# Drafting feedback 1\n\n## Round\n\nReviewer: Q1: yes\n\n## Comments\n\n1. \`${WIP}.review/v1.md\`, general\n   No.\n`,
    );
    expect(round.heard).toEqual([{ file, seq: 1, more: true }]);
  });

  test("a part alone is a batch, and its commit hears it holds nothing more", async () => {
    const round = rounding();
    const s = setup([round.extension]);
    expect((await send(s, {})).ok).toBe(true);
    expect(round.heard).toEqual([{ file: `${WIP}.review/v0.feedback-1.md`, seq: 1, more: false }]);
  });

  test("a choice alone is a batch, and a part's commit hears the batch holds more than the part", async () => {
    const round = rounding();
    const s = setup([round.extension]);
    const layout = { layout: { option: "d", label: "D", description: ARTICLE } };
    expect((await send(s, { choices: { [`${WIP}layout.html`]: layout } })).ok).toBe(true);
    expect(round.heard).toEqual([{ file: `${WIP}.review/v0.feedback-1.md`, seq: 1, more: true }]);
    expect(read(s.root, `${WIP}.review/v0.feedback-1.md`)).toContain("## Choices\n\n1. ");
    expect(existsSync(join(s.root, DRAFT))).toBe(false);
  });

  test("the draft keeps what the Send did not take, a part's typing leaving it as the part says", async () => {
    const round = rounding();
    const s = setup([round.extension]);
    const typed = { ...EMPTY_TYPED, general: "taken by the part", composer: { x: "kept" } };
    await send(s, { annotations: [GENERAL_NO, ANOTHER], typed }, { annotations: ["a"] });
    expect(JSON.parse(read(s.root, DRAFT))).toEqual({
      annotations: [ANOTHER],
      edit: null,
      choices: {},
      typed: { ...typed, general: "" },
    });
  });

  test("Send now asks no extension for its part", async () => {
    const round = rounding(["Q2"]);
    const s = setup([round.extension]);
    await send(s, { annotations: [GENERAL_NO, ANOTHER] }, SEND_NOW);
    expect(read(s.root, `${WIP}.review/v0.feedback-1.md`)).not.toContain("## Round");
    expect(round.heard).toEqual([]);
  });

  test("an entry that cannot be written leaves no batch and runs no commit: the Send can go again", async () => {
    const round = rounding();
    const extended = setup([round.extension]);
    await extended.review.openChannel();
    rmSync(join(extended.root, WIP, ".review/channel.jsonl"));
    mkdirSync(join(extended.root, WIP, ".review/channel.jsonl"));

    await expect(send(extended, SAY_NO)).rejects.toThrow();
    expect(existsSync(join(extended.root, WIP, ".review/v0.feedback-1.md"))).toBe(false);
    expect(round.heard).toEqual([]);
    expect(existsSync(join(extended.root, DRAFT))).toBe(true);
  });

  test("a commit that throws leaves the batch sent", async () => {
    const broken: ServerExtension = {
      id: "broken",
      part: () =>
        Promise.resolve({
          kind: "part",
          text: "## Broken",
          typed: (typed) => typed,
          commit: () => Promise.reject(new Error("disk full")),
        }),
    };

    const s = setup([broken]);
    expect(await send(s, SAY_NO)).toMatchObject({ ok: true, seq: 1 });
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
    hold.reason = "grill 1 is open";

    expect(await review.gate()).toEqual({
      ok: false,
      error: "grill 1 is open: the plan is submitted once the reviewer ends it",
    });
    expect(existsSync(join(root, WIP, ".review/v1.md"))).toBe(false);
  });

  test("a Send goes through, while drafting and under review alike", async () => {
    const hold = holding();
    const s = setup([hold.extension]);
    hold.reason = "grill 1 is open";

    expect((await send(s, SAY_NO)).ok).toBe(true);
    hold.reason = null;
    writeFileSync(join(s.root, WIP, "plan.md"), PLAN);
    await s.review.gate();
    hold.reason = "grill 1 is open";

    expect((await send(s, SAY_NO)).ok).toBe(true);
    expect(existsSync(join(s.root, WIP, ".review/v1.feedback-1.md"))).toBe(true);
  });

  test("the view carries the reason, and `null` once nothing holds", async () => {
    const hold = holding();
    const { review } = setup([hold.extension]);
    hold.reason = "grill 1 is open";

    expect((await review.view()).held).toBe("grill 1 is open");
    hold.reason = null;

    expect((await review.view()).held).toBeNull();
  });

  test("an extension reads the hold through its context: the first extension's reason", async () => {
    const hold = holding();
    const { review } = setup([{ id: "quiet" }, hold.extension]);

    expect(await review.context.inOrder(() => review.context.held())).toBeNull();
    hold.reason = "grill 1 is open";

    expect(await review.context.inOrder(() => review.context.held())).toBe("grill 1 is open");
  });
});

describe("a request an extension holds", () => {
  test("reads again at each wake, and answers the first read no longer waiting", async () => {
    const { review } = setup([]);
    const reads: string[] = [];
    let state = "open";

    const held = review.context.hold(
      () => {
        reads.push(state);

        return Promise.resolve(state);
      },
      (value) => value === "open",
    );

    await Bun.sleep(5);
    review.context.wake();
    await Bun.sleep(5);
    state = "answered";
    review.context.wake();

    expect(await held).toBe("answered");
    expect(reads).toEqual(["open", "open", "answered"]);
  });

  test("answers at once what is not waiting, and a wake with nothing held does nothing", async () => {
    const { review } = setup([]);
    review.context.wake();

    expect(
      await review.context.hold(
        () => Promise.resolve(1),
        (value) => value === 0,
      ),
    ).toBe(1);
  });
});

describe("an extension started from another's route", () => {
  test("runs in the caller's step of the queue, and answers what Claude is told of it", async () => {
    const order: string[] = [];

    const started: ServerExtension = {
      id: "started",
      start: (_, input) => {
        order.push(`start ${JSON.stringify(input)}`);

        return Promise.resolve({
          ok: true,
          value: { told: "opened", commit: () => Promise.resolve() },
        });
      },
    };

    const { review } = setup([started]);

    const first = review.context.inOrder(async () => {
      const opened = await review.context.start("started", { subject: "a" });
      order.push("caller");

      return opened;
    });

    const second = review.context.inOrder(() => {
      order.push("next step");

      return Promise.resolve();
    });

    expect(await first).toMatchObject({ ok: true, value: { told: "opened" } });
    await second;
    expect(order).toEqual(['start {"subject":"a"}', "caller", "next step"]);
  });

  test("an id no extension starts is refused, naming it", async () => {
    const { review } = setup([{ id: "quiet" }]);

    expect(await review.context.start("quiet", {})).toEqual({
      ok: false,
      error: "no extension quiet starts",
    });
    expect(await review.context.start("nobody", {})).toEqual({
      ok: false,
      error: "no extension nobody starts",
    });
  });

  test("an approval goes through, and `approved` runs after the rename, on the final directory", async () => {
    const seen: string[] = [];

    const closer: ServerExtension = {
      id: "closer",
      holds: () => Promise.resolve("grill 1 is open"),
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

describe("the channel as the server opens it", () => {
  test("an entry appended to a channel whose last line has no newline is read back under its number", async () => {
    const s = await gated();
    writeFileSync(join(s.root, WIP, ".review/channel.jsonl"), '{"kind":"te');
    await send(s, SAY_NO);

    expect(await s.review.channel(0)).toEqual([
      { seq: 2, entry: { kind: "sent", file: `${WIP}.review/v1.feedback-1.md` as never } },
    ]);
  });

  test("a Send whose entry failed leaves nothing to tell: the page saw it fail, and sends again", async () => {
    const s = await gated();
    await s.review.openChannel();
    rmSync(join(s.root, WIP, ".review/channel.jsonl"));
    mkdirSync(join(s.root, WIP, ".review/channel.jsonl"));

    await expect(send(s, SAY_NO)).rejects.toThrow();
    rmSync(join(s.root, WIP, ".review/channel.jsonl"), { recursive: true });
    writeFileSync(join(s.root, WIP, ".review/channel.jsonl"), "");
    await s.review.openChannel();

    expect(await told(s.review)).toEqual([]);
  });

  test("a batch whose entry was never written, a server killed between the two, is told when the channel opens again", async () => {
    const s = await gated();
    await s.review.openChannel();
    writeFileSync(join(s.root, WIP, ".review/v1.feedback-1.md"), "# Plan review: batch 1 on v1\n");
    await s.review.openChannel();

    expect(await told(s.review)).toEqual([
      { kind: "sent", file: `${WIP}.review/v1.feedback-1.md` },
    ]);
  });

  test("a directory with no channel yet tells none of the files it already holds", async () => {
    const s = await gated();
    await send(s, SAY_NO);
    rmSync(join(s.root, WIP, ".review/channel.jsonl"));
    await s.review.openChannel();

    expect(await told(s.review)).toEqual([]);
  });

  test("a feedback file an older vellum wrote becomes its version's first batch at open, the channel naming it there", async () => {
    const s = await gated();
    const old = `${WIP}.review/v1.feedback.md`;
    writeFileSync(join(s.root, old), "# Plan review: changes requested (v1)\n");
    writeFileSync(
      join(s.root, WIP, ".review/channel.jsonl"),
      `${JSON.stringify({ kind: "sent", file: old })}\n`,
    );
    await s.review.openChannel();

    expect(existsSync(join(s.root, old))).toBe(false);
    expect(read(s.root, `${WIP}.review/v1.feedback-1.md`)).toContain("changes requested (v1)");
    expect(await told(s.review)).toEqual([
      { kind: "sent", file: `${WIP}.review/v1.feedback-1.md` },
    ]);
    expect(await s.review.workspace()).toMatchObject({ kind: "inReview", version: 1, batches: 1 });
  });

  test("a directory older than the channel has its feedback file renamed too, and tells nothing", async () => {
    const s = await gated();
    writeFileSync(
      join(s.root, WIP, ".review/v1.feedback.md"),
      "# Plan review: changes requested (v1)\n",
    );
    rmSync(join(s.root, WIP, ".review/channel.jsonl"), { force: true });
    await s.review.openChannel();

    expect(existsSync(join(s.root, WIP, ".review/v1.feedback-1.md"))).toBe(true);
    expect(await told(s.review)).toEqual([]);
  });

  test("the channel's identity is minted once, and the approval's rename carries it", async () => {
    const { review } = await gated();
    const id = await review.openChannel();

    expect(await review.openChannel()).toBe(id);
    await review.decide(APPROVE);

    expect(await review.openChannel()).toBe(id);
  });
});
