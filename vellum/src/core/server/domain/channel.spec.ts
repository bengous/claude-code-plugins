/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, FinalDir, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";

import type { ChannelEntry } from "./channel.ts";
import { appended, channelAfter, channelLine, untold } from "./channel.ts";
import type { PlanWorkspace } from "./workspace.ts";

const WIP = "plans/2026-09-24/wip-4c2a9d93/";

const FINAL = "plans/2026-09-24/auth/";

const SENT: ChannelEntry = { kind: "sent", file: `${WIP}.review/v1.feedback.md` as never };

const APPROVED: ChannelEntry = {
  kind: "approved",
  version: 2 as never,
  dir: FINAL as never,
  notes: null,
};

const TEXT: ChannelEntry = { kind: "text", from: "grill", text: "Reviewer: Q1: yes\n\nQ2: no" };

const IN_REVIEW: PlanWorkspace = {
  kind: "inReview",
  dir: WIP as never,
  version: 2 as never,
  batches: 1,
  finalizeError: null,
};

function channel(...entries: ChannelEntry[]): string {
  return entries.map((entry) => channelLine(entry)).join("");
}

function sent(name: string, dir = WIP): ChannelEntry {
  return { kind: "sent", file: `${dir}.review/${name}` as never };
}

describe("the channel file", () => {
  test("an entry's number is its line: the first is 1, the next follows the last", () => {
    expect(appended("", SENT).seq).toBe(1);
    expect(appended(channel(SENT, TEXT), APPROVED)).toEqual({
      text: channelLine(APPROVED),
      seq: 3,
    });
  });

  test("a last line with no newline is ended first, so no entry is glued to it", () => {
    const { text, seq } = appended(`${channel(SENT)}{"kind":"te`, TEXT);
    const file = `${channel(SENT)}{"kind":"te${text}`;

    expect(seq).toBe(3);
    expect(channelAfter(file, 0)).toEqual([
      { seq: 1, entry: SENT },
      { seq: 3, entry: TEXT },
    ]);
  });

  test("reads back what it wrote, each entry under its line number", () => {
    expect(channelAfter(channel(SENT, APPROVED, TEXT), 0)).toEqual([
      { seq: 1, entry: SENT },
      { seq: 2, entry: APPROVED },
      { seq: 3, entry: TEXT },
    ]);
  });

  test("hands only the entries past the number asked", () => {
    expect(channelAfter(channel(SENT, TEXT), 1)).toEqual([{ seq: 2, entry: TEXT }]);
    expect(channelAfter(channel(SENT, TEXT), 2)).toEqual([]);
  });

  test("a line with no newline yet is not an entry yet", () => {
    expect(channelAfter(`${channel(SENT)}{"kind":"te`, 0)).toEqual([{ seq: 1, entry: SENT }]);
  });

  test("a line that is no entry is left out, and the next keeps its number", () => {
    const forged = `${channel(SENT)}{"kind":"sent","file":"/etc/passwd"}\n${channel(TEXT)}`;

    expect(channelAfter(forged, 0)).toEqual([
      { seq: 1, entry: SENT },
      { seq: 3, entry: TEXT },
    ]);
  });

  test("an approval's notes are a path or null, and its directory a final one", () => {
    const notes = `${FINAL}.review/v2.notes.md`;

    expect(channelAfter(channel({ ...APPROVED, notes: notes as never }), 0)).toHaveLength(1);
    expect(channelAfter(`${JSON.stringify({ ...APPROVED, notes: 3 })}\n`, 0)).toEqual([]);
    expect(channelAfter(`${JSON.stringify({ ...APPROVED, dir: WIP })}\n`, 0)).toEqual([]);
  });
});

describe("untold", () => {
  test("names each feedback file no entry names, the batches first, in the order sent", () => {
    const names = new Set(["v2.md", "v1.feedback.md", "v0.feedback-2.md", "v0.feedback-1.md"]);

    expect(untold(IN_REVIEW, names, [{ seq: 1, entry: sent("v0.feedback-1.md") }])).toEqual([
      sent("v0.feedback-2.md"),
      sent("v1.feedback.md"),
    ]);
  });

  test("tells the approval of an approved directory whose channel lacks it", () => {
    const approved: PlanWorkspace = {
      kind: "approved",
      dir: FINAL as never,
      version: 2 as never,
      notes: true,
    };

    expect(untold(approved, new Set(["v2.md", "v2.notes.md"]), [])).toEqual([
      { ...APPROVED, notes: `${FINAL}.review/v2.notes.md` as never },
    ]);
    expect(untold(approved, new Set(["v2.md"]), [{ seq: 1, entry: APPROVED }])).toEqual([]);
  });

  test("a directory whose channel names every file tells nothing", () => {
    expect(untold(IN_REVIEW, new Set(["v1.feedback.md"]), [{ seq: 1, entry: SENT }])).toEqual([]);
  });
});
