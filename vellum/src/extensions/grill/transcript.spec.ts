import { describe, expect, test } from "bun:test";

import {
  appendAnswer,
  appendEvent,
  appendFooter,
  appendQuestions,
  appendReply,
  closedBy,
  header,
  isClosed,
  phaseOf,
  reviewerEntry,
  segmentsOf,
  subjectOf,
  unanswered,
} from "./transcript.ts";

const AT = new Date(2026, 8, 16, 14, 2);

const STYLE = { title: "Style", ask: "bright or plain?", rec: "I recommend bright." };

const opened = header("auth", "4c2a9d93", AT);

const asked = appendAnswer(appendQuestions(opened, [STYLE, STYLE]), "Asked.", "answer");

/** Each question of the file with its answer, in order. */
function answers(doc: string): (string | null)[] {
  return segmentsOf(doc).flatMap((segment) =>
    segment.kind === "question" ? [segment.answer] : [],
  );
}

describe("a round", () => {
  test("is opened by Claude's questions, numbered across the grill", () => {
    const again = appendQuestions(appendReply(asked, [], "") ?? "", [STYLE]);

    expect(asked).toBe(
      `${opened}\n## Round 1\n\n### Claude\n\n❓ **Q1** - **Style**: bright or plain?\n\n➡️ I recommend bright.\n\n---\n\n❓ **Q2** - **Style**: bright or plain?\n\n➡️ I recommend bright.\n\n---\n\nAsked.\n`,
    );
    expect(again).toContain("\n## Round 2\n\n### Claude\n\n❓ **Q3** - **Style**");
  });

  test("holds the reviewer's reply, and an empty field takes the recommendation by default", () => {
    expect(appendReply(asked, [{ id: "Q2", text: " plain " }], "")).toBe(
      `${asked}\n### Reviewer\n\nQ1: As recommended, by default.\n\nQ2: plain\n`,
    );
  });

  test("a reply answers open questions alone, and a note may go without any", () => {
    const replied = appendReply(asked, [], "") ?? "";

    expect(appendReply(replied, [{ id: "Q1", text: "changed my mind" }], "")).toBeNull();
    expect(appendReply(replied, [], "one more thing")).toEndWith(
      "### Reviewer\n\nNote: one more thing\n",
    );
  });

  test("a harness event opens nothing: the questions asked before it still take an answer", () => {
    const resumed = appendEvent(asked, "/vellum:start\nwith arguments");

    expect(resumed).toEndWith("\n_(session: /vellum:start)_\n");
    expect(unanswered(resumed)).toEqual(["Q1", "Q2"]);
    expect(appendReply(resumed, [{ id: "Q1", text: "bright" }], "")).toContain("Q1: bright");
  });
});

describe("Claude's final text", () => {
  test("is kept under the opening, under a reply, and under the round its turn asked", () => {
    const replied = appendReply(asked, [], "") ?? "";

    expect(appendAnswer(opened, "Two facts first.", "answer")).toEndWith(
      "\n### Claude\n\nTwo facts first.\n",
    );
    expect(appendAnswer(replied, "The frontier is empty.", "answer")).toEndWith(
      "by default.\n\n### Claude\n\nThe frontier is empty.\n",
    );
  });

  test("of a turn that answered the terminal is not the grill's", () => {
    expect(appendAnswer(asked, "Sure, here is the weather.", "answer")).toBe(asked);
  });

  test("an interrupted turn says so", () => {
    expect(appendAnswer(opened, "partial", "aborted")).toEndWith(
      "### Claude\n\npartial\n\n_(turn aborted)_\n",
    );
  });
});

describe("what the engine relays", () => {
  test("the opening while Claude said nothing, then each reply until Claude speaks under it", () => {
    const replied = appendReply(asked, [{ id: "Q1", text: "plain" }], "and hurry") ?? "";

    expect(reviewerEntry(opened)).toEqual({ round: 0, text: "" });
    expect(reviewerEntry(asked)).toBeNull();
    expect(reviewerEntry(replied)).toEqual({
      round: 1,
      text: "Q1: plain\n\nQ2: As recommended, by default.\n\nNote: and hurry",
    });
    expect(reviewerEntry(appendQuestions(replied, [STYLE]))).toBeNull();
  });

  test("the phase is working while an entry waits for Claude", () => {
    expect(phaseOf(opened)).toBe("working");
    expect(phaseOf(asked)).toBe("waiting");
  });
});

describe("the footer", () => {
  test("closes the file and says who closed it; a rule inside an answer does not", () => {
    expect(closedBy(appendFooter(asked, "page", AT))).toBe("page");
    expect(isClosed(appendAnswer(opened, "a\n\n---\n\nClosed questions below", "answer"))).toBe(
      false,
    );
    expect(subjectOf(opened)).toBe("auth");
  });
});

describe("the page's segments", () => {
  test("a question is data, its markers and its closing rule never Markdown", () => {
    const segments = segmentsOf(asked);

    expect(segments.slice(1)).toEqual([
      { kind: "question", id: "Q1", ...STYLE, answer: null },
      { kind: "question", id: "Q2", ...STYLE, answer: null },
      { kind: "markdown", text: "\nAsked.\n" },
    ]);
    expect(JSON.stringify(segments)).not.toMatch(/❓|➡️/u);
  });

  test("an answer is read beside its question, and of a reply only the note stays as text", () => {
    const replied = appendReply(asked, [{ id: "Q1", text: "plain\nfor now" }], "and hurry") ?? "";

    expect(answers(replied)).toEqual(["plain\nfor now", "As recommended, by default."]);
    expect(segmentsOf(replied).at(-1)).toEqual({
      kind: "markdown",
      text: "\nAsked.\n\n### Reviewer\n\nand hurry\n\n",
    });
  });

  test("a question Claude typed by hand, with a long dash, is a card too", () => {
    const typed =
      "❓ **Q1** – **Riding times**: day or night?\n\n➡️ *Both*\n\n---\n\nYour answers?";

    expect(segmentsOf(appendAnswer(opened, typed, "answer")).slice(1)).toEqual([
      {
        kind: "question",
        id: "Q1",
        title: "Riding times",
        ask: "day or night?",
        rec: "*Both*",
        answer: null,
      },
      { kind: "markdown", text: "\nYour answers?\n" },
    ]);
  });
});
