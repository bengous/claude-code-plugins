/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, FinalDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";

import type { ChannelEntry } from "./channel.ts";
import { channelAfter, channelLine, nextSeq } from "./channel.ts";

const SENT: ChannelEntry = {
  kind: "sent",
  file: "plans/2026-09-24/wip-4c2a9d93/.review/v1.feedback.md" as never,
};

const APPROVED: ChannelEntry = {
  kind: "approved",
  version: 2 as never,
  dir: "plans/2026-09-24/auth/" as never,
  notes: null,
};

const TEXT: ChannelEntry = { kind: "text", from: "grill", text: "Reviewer: Q1: yes\n\nQ2: no" };

function channel(...entries: ChannelEntry[]): string {
  return entries.map((entry) => channelLine(entry)).join("");
}

describe("the channel file", () => {
  test("an entry's number is its line: the first is 1, the next follows the last", () => {
    expect(nextSeq("")).toBe(1);
    expect(nextSeq(channel(SENT, TEXT))).toBe(3);
  });

  test("reads back what it wrote, each entry under its line number", () => {
    expect(channelAfter(channel(SENT, APPROVED, TEXT), 0)).toEqual({
      ok: true,
      value: [
        { seq: 1, entry: SENT },
        { seq: 2, entry: APPROVED },
        { seq: 3, entry: TEXT },
      ],
    });
  });

  test("hands only the entries past the number asked", () => {
    expect(channelAfter(channel(SENT, TEXT), 1)).toEqual({
      ok: true,
      value: [{ seq: 2, entry: TEXT }],
    });
    expect(channelAfter(channel(SENT, TEXT), 2)).toEqual({ ok: true, value: [] });
  });

  test("a line with no newline yet is not an entry yet", () => {
    expect(channelAfter(`${channel(SENT)}{"kind":"te`, 0)).toEqual({
      ok: true,
      value: [{ seq: 1, entry: SENT }],
    });
  });

  test("a line that is no entry is refused by its number, never skipped", () => {
    const forged = `${channel(SENT)}{"kind":"sent","file":"/etc/passwd"}\n${channel(TEXT)}`;

    expect(channelAfter(forged, 0)).toEqual({
      ok: false,
      error: expect.stringContaining(".review/channel.jsonl, line 2, is no entry"),
    });
    expect(channelAfter(forged, 2)).toEqual({ ok: true, value: [{ seq: 3, entry: TEXT }] });
  });

  test("an approval's notes are a path or null, and its directory a final one", () => {
    const notes = "plans/2026-09-24/auth/.review/v2.notes.md";

    expect(channelAfter(channel({ ...APPROVED, notes: notes as never }), 0).ok).toBe(true);
    expect(channelAfter(`${JSON.stringify({ ...APPROVED, notes: 3 })}\n`, 0).ok).toBe(false);
    expect(
      channelAfter(`${JSON.stringify({ ...APPROVED, dir: "plans/2026-09-24/wip-4c2a9d93/" })}\n`, 0)
        .ok,
    ).toBe(false);
  });
});
