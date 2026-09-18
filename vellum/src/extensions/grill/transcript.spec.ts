import { describe, expect, test } from "bun:test";

import {
  appendAnswer,
  appendFooter,
  appendPrompt,
  appendQuestions,
  header,
  isClosed,
  phaseOf,
  REVIEWER,
  reviewerRound,
  segmentsOf,
  subjectOf,
} from "./transcript.ts";

const AT = new Date(2026, 8, 16, 14, 2);

const STYLE = { title: "Style", ask: "bright or plain?", rec: "bright" };

/** Whether each question of the file takes an answer, in order. */
function open(doc: string): boolean[] {
  return segmentsOf(doc).flatMap((segment) => (segment.kind === "question" ? [segment.open] : []));
}

const opened = appendPrompt(header("auth", "4c2a9d93", AT), REVIEWER, "Grill me on: auth");

describe("the transcript", () => {
  test("opens on the reviewer's gesture as round 1", () => {
    expect(opened).toBe(
      "# Grill: auth\n\nStarted 2026-09-16 14:02 · session 4c2a9d93\n\n## Round 1\n\n### Reviewer\n\nGrill me on: auth\n",
    );
    expect(subjectOf(opened)).toBe("auth");
  });

  test("numbers a round per prompt and keeps both voices word for word", () => {
    const doc = appendPrompt(appendAnswer(opened, "Two facts first.", "answer"), "User", "go on");

    expect(doc).toEndWith("### Claude\n\nTwo facts first.\n\n## Round 2\n\n### User\n\ngo on\n");
  });

  test("an interrupted turn says so under the answer", () => {
    expect(appendAnswer("", "partial", "aborted")).toBe(
      "\n### Claude\n\npartial\n\n_(turn aborted)_\n",
    );
  });

  test("reads working, waiting and closed off the file alone", () => {
    const answered = appendAnswer(opened, "Q1", "answer");

    expect(phaseOf(opened)).toBe("working");
    expect(phaseOf(answered)).toBe("waiting");
    expect(isClosed(answered)).toBe(false);
    expect(isClosed(appendFooter(answered, "page", AT))).toBe(true);
  });

  test("Claude's own round and voice headings neither count as a round nor as a voice", () => {
    const answered = appendAnswer(opened, "## Round 1\n\n❓ Q1\n\n### Notes\n\nx", "answer");

    expect(phaseOf(answered)).toBe("waiting");
    expect(appendPrompt(answered, "User", "a")).toContain("\n## Round 2\n\n### User\n");
  });

  test("a rule inside an answer does not read as the footer", () => {
    expect(isClosed(appendAnswer(opened, "a\n\n---\n\nClosed questions below", "answer"))).toBe(
      false,
    );
  });

  test("numbers asked questions across rounds and keeps the final text under the same voice", () => {
    const asked = appendQuestions(opened, [STYLE, STYLE]);
    const done = appendAnswer(asked, "Asked.", "answer");
    const again = appendQuestions(appendPrompt(done, REVIEWER, "Q1: a\n\nQ2: b"), [STYLE]);

    expect(asked).toEndWith(
      "### Claude\n\n❓ **Q1** - **Style**: bright or plain?\n\n➡️ bright\n\n---\n\n❓ **Q2** - **Style**: bright or plain?\n\n➡️ bright\n\n---\n",
    );
    expect(done).toBe(`${asked}\nAsked.\n`);
    expect(again).toContain("\n### Claude\n\n❓ **Q3** - **Style**");
    expect(appendAnswer(asked, "", "answer")).toBe(asked);
  });
});

describe("the reviewer's round", () => {
  test("is the last one the reviewer wrote, until Claude answers under it", () => {
    const replied = appendPrompt(appendAnswer(opened, "Q1?", "answer"), REVIEWER, "Q1: yes");

    expect(reviewerRound(opened)).toEqual({ round: 1, text: "Grill me on: auth" });
    expect(reviewerRound(replied)).toEqual({ round: 2, text: "Q1: yes" });
    expect(reviewerRound(appendAnswer(replied, "Noted.", "answer"))).toBeNull();
  });

  test("a round typed in the terminal meanwhile does not cancel it", () => {
    expect(reviewerRound(appendPrompt(opened, "User", "wait"))).toEqual({
      round: 1,
      text: "Grill me on: auth",
    });
  });
});

describe("the page's segments", () => {
  test("a question is data, its markers and its closing rule never Markdown", () => {
    const segments = segmentsOf(appendAnswer(appendQuestions(opened, [STYLE]), "Asked.", "answer"));

    expect(segments.slice(2)).toEqual([
      { kind: "question", id: "Q1", ...STYLE, open: true },
      { kind: "markdown", text: "\nAsked.\n" },
    ]);
    expect(JSON.stringify(segments)).not.toMatch(/❓|➡️/u);
  });

  test("a question Claude typed by hand, with a long dash, is a card too", () => {
    const typed =
      "❓ **Q1** – **Riding times**: day or night?\n\n➡️ *Both*\n\n---\n\nYour answers?";

    expect(segmentsOf(appendAnswer(opened, typed, "answer")).slice(2)).toEqual([
      {
        kind: "question",
        id: "Q1",
        title: "Riding times",
        ask: "day or night?",
        rec: "*Both*",
        open: true,
      },
      { kind: "markdown", text: "\nYour answers?\n" },
    ]);
  });

  test("only the round that waits for the reviewer takes an answer", () => {
    const asked = appendAnswer(appendQuestions(opened, [STYLE]), "Asked.", "answer");
    const replied = appendPrompt(asked, REVIEWER, "Q1: bright");

    expect(open(replied)).toEqual([false]);
    expect(open(appendFooter(asked, "page", AT))).toEqual([false]);
    expect(open(appendQuestions(replied, [STYLE]))).toEqual([false, true]);
  });
});
