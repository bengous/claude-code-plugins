import { describe, expect, test } from "bun:test";

import type { Answer, GrillPosts } from "./protocol.ts";
import {
  appendAnswer,
  appendEvent,
  appendFooter,
  appendQuestions,
  appendReply,
  header,
  isClosed,
  phaseOf,
  relaysOf,
  segmentsOf,
  subjectOf,
  unanswered,
} from "./transcript.ts";

const AT = new Date(2026, 8, 16, 14, 2);

const STYLE = { title: "Style", ask: "bright or plain?", rec: "I recommend bright." };

const opened = header("auth", "4c2a9d93", AT);

/** Claude's final text as the hooks module posts it: by default a turn a relay started, ended on its answer, that asked no round. */
function said(text: string, turn: Partial<GrillPosts["answer"]> = {}): GrillPosts["answer"] {
  return { text, reason: "answer", own: true, asked: false, ...turn };
}

const asked = appendAnswer(
  appendQuestions(opened, [STYLE, STYLE]),
  said("Asked.", { asked: true }),
);

/** Each question of the file with its answer, in order. */
function answers(doc: string): Answer[] {
  return segmentsOf(doc).flatMap((segment) =>
    segment.kind === "question" ? [segment.answer] : [],
  );
}

/** Each question of the file with its round, in order. */
function rounds(doc: string): number[] {
  return segmentsOf(doc).flatMap((segment) => (segment.kind === "question" ? [segment.round] : []));
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
  test("of a turn a vellum relay started is kept, under the opening and under a reply", () => {
    const replied = appendReply(asked, [], "") ?? "";

    expect(appendAnswer(opened, said("Two facts first."))).toEndWith(
      "\n### Claude\n\nTwo facts first.\n",
    );
    expect(appendAnswer(replied, said("The frontier is empty."))).toEndWith(
      "by default.\n\n### Claude\n\nThe frontier is empty.\n",
    );
  });

  test("of a turn the terminal started writes nothing, a reply waiting or not", () => {
    const replied = appendReply(asked, [], "") ?? "";

    expect(appendAnswer(replied, said("Sure, here is the weather.", { own: false }))).toBe(replied);
    expect(appendAnswer(asked, said("Sure, here is the weather.", { own: false }))).toBe(asked);
  });

  test("closes the round its turn just asked, whoever started the turn", () => {
    const round = appendQuestions(opened, [STYLE]);

    expect(appendAnswer(round, said("Asked.", { own: false, asked: true }))).toBe(
      `${round}\nAsked.\n`,
    );
  });

  test("of the turn that asked goes with its round, before a reply sent meanwhile", () => {
    const round = appendQuestions(opened, [STYLE]);
    const early = appendReply(round, [], "") ?? "";

    expect(appendAnswer(early, said("Asked.", { asked: true }))).toBe(
      appendReply(`${round}\nAsked.\n`, [], "") ?? "",
    );
  });

  test("of a turn that asked nothing writes no line under an open round", () => {
    const round = appendQuestions(opened, [STYLE]);

    expect(appendAnswer(round, said("Sure, here is the weather.", { own: false }))).toBe(round);
  });

  test("of the turn that asked goes nowhere once its grill closed: the next grill has no round", () => {
    const next = appendReply(header("storage", "4c2a9d93", AT), [], "Start with the cache.") ?? "";

    expect(appendAnswer(next, said("Asked.", { asked: true }))).toBe(next);
  });

  test("an interrupted turn says so", () => {
    expect(appendAnswer(opened, said("partial", { reason: "aborted" }))).toEndWith(
      "### Claude\n\npartial\n\n_(turn aborted)_\n",
    );
  });
});

describe("what the engine relays", () => {
  const NAME = "grill-2.md";

  const once = appendReply(asked, [{ id: "Q1", text: "plain" }], "and hurry") ?? "";

  const twice = appendReply(appendQuestions(once, [STYLE]), [], "one more thing") ?? "";

  test("the opening is entry 0, and names the file and the subject", () => {
    expect(relaysOf(opened, NAME, -1)).toEqual([
      { kind: "opened", seq: 0, name: NAME, subject: "auth" },
    ]);
    expect(relaysOf(opened, NAME, 0)).toEqual([]);
  });

  test("a reply goes as the reviewer's: the note first, then the answers they typed, never a default", () => {
    expect(relaysOf(once, NAME, 0)).toEqual([
      { kind: "reply", seq: 1, text: "Reviewer: and hurry\n\nQ1: plain" },
    ]);
  });

  test("a reply with nothing typed is one line", () => {
    expect(relaysOf(appendReply(asked, [], "") ?? "", NAME, 0)).toEqual([
      { kind: "reply", seq: 1, text: "Reviewer: all open questions as recommended." },
    ]);
  });

  test("two replies before one poll both come out, in order, and Claude's voice after one cancels nothing", () => {
    const spoken = appendAnswer(twice, said("Noted."));

    expect(relaysOf(spoken, NAME, 0).map((relay) => relay.seq)).toEqual([1, 2]);
    expect(relaysOf(spoken, NAME, 1)).toEqual([
      { kind: "reply", seq: 2, text: "Reviewer: one more thing" },
    ]);
  });

  test("the end comes after the replies still due, and only when the reviewer ended it from the page", () => {
    expect(relaysOf(appendFooter(twice, "page", AT), NAME, 1).map((relay) => relay.kind)).toEqual([
      "reply",
      "ended",
    ]);
    expect(relaysOf(appendFooter(twice, "page", AT), NAME, 2)).toEqual([
      { kind: "ended", seq: 3, name: NAME },
    ]);
    expect(relaysOf(appendFooter(twice, "stop", AT), NAME, 2)).toEqual([]);
  });
});

describe("the phase", () => {
  const replied = appendReply(asked, [], "") ?? "";

  test("is asking while a question waits for the reviewer", () => {
    expect(phaseOf(asked)).toBe("asking");
  });

  test("is working while the reviewer spoke last: the opening, or a reply no voice of Claude follows", () => {
    expect(phaseOf(opened)).toBe("working");
    expect(phaseOf(appendEvent(replied, "/compact"))).toBe("working");
  });

  test("is idle once Claude's turn after the reply ended on its answer", () => {
    expect(phaseOf(appendAnswer(replied, said("The frontier is empty.")))).toBe("idle");
  });

  test("is stopped when Claude's turn after the reply was aborted, refused or failed", () => {
    for (const reason of ["aborted", "refusal", "error"]) {
      expect(phaseOf(appendAnswer(replied, said("partial", { reason })))).toBe("stopped");
    }
  });

  test("a reply sent before the asking turn's end, then that turn's closing text, is working", () => {
    const early = appendReply(appendQuestions(opened, [STYLE]), [], "") ?? "";

    expect(phaseOf(appendAnswer(early, said("Asked.", { asked: true })))).toBe("working");
  });

  test("an event after an aborted turn leaves it stopped", () => {
    const aborted = appendAnswer(replied, said("partial", { reason: "aborted" }));

    expect(phaseOf(appendEvent(aborted, "/compact"))).toBe("stopped");
  });
});

describe("the footer", () => {
  test("closes the file; a rule inside an answer does not", () => {
    const ruled = appendAnswer(opened, said("a\n\n---\n\nClosed questions below"));

    expect(isClosed(appendFooter(asked, "page", AT))).toBe(true);
    expect(isClosed(ruled)).toBe(false);
    expect(subjectOf(opened)).toBe("auth");
  });
});

describe("the page's segments", () => {
  test("a question is data, its markers and its closing rule never Markdown", () => {
    const segments = segmentsOf(asked);

    expect(segments.slice(0, 2)).toEqual([
      { kind: "opened", subject: "auth", at: expect.any(String) },
      { kind: "markdown", text: "\n## Round 1\n\n### Claude\n" },
    ]);
    expect(segments.slice(2)).toEqual([
      { kind: "question", id: "Q1", round: 1, ...STYLE, answer: { kind: "open" } },
      { kind: "question", id: "Q2", round: 1, ...STYLE, answer: { kind: "open" } },
      { kind: "markdown", text: "\nAsked.\n" },
    ]);
    expect(JSON.stringify(segments)).not.toMatch(/❓|➡️/u);
  });

  test("an answer is read beside its question, and of a reply only the note stays as text", () => {
    const replied = appendReply(asked, [{ id: "Q1", text: "plain\nfor now" }], "and hurry") ?? "";

    expect(answers(replied)).toEqual([
      { kind: "typed", text: "plain\nfor now" },
      { kind: "default" },
    ]);
    expect(segmentsOf(replied).at(-1)).toEqual({
      kind: "markdown",
      text: "\nAsked.\n\n### Reviewer\n\nand hurry\n\n",
    });
  });

  test("a question Claude typed by hand, with a long dash, is a card too", () => {
    const typed =
      "❓ **Q1** – **Riding times**: day or night?\n\n➡️ *Both*\n\n---\n\nYour answers?";

    expect(segmentsOf(appendAnswer(opened, said(typed))).slice(2)).toEqual([
      {
        kind: "question",
        id: "Q1",
        round: 0,
        title: "Riding times",
        ask: "day or night?",
        rec: "*Both*",
        answer: { kind: "open" },
      },
      { kind: "markdown", text: "\nYour answers?\n" },
    ]);
  });

  test("an answer is one of four kinds: open, taken by default, the recommendation chosen, typed", () => {
    const three = appendQuestions(opened, [STYLE, STYLE, STYLE]);

    const chosen = [
      { id: "Q1", text: "As recommended." },
      { id: "Q2", text: "plain" },
    ];

    const replied = appendQuestions(appendReply(three, chosen, "") ?? "", [STYLE]);

    expect(answers(replied)).toEqual([
      { kind: "recommended" },
      { kind: "typed", text: "plain" },
      { kind: "default" },
      { kind: "open" },
    ]);
  });

  test("a question number typed again is text: the first card with that number stands", () => {
    const again = appendAnswer(asked, said("❓ **Q1** - **Again**: once more?\n\n---\n"));
    const questions = segmentsOf(again).filter((segment) => segment.kind === "question");

    expect(questions.map((question) => question.title)).toEqual(["Style", "Style"]);
    expect(unanswered(again)).toEqual(["Q1", "Q2"]);
  });

  test("a question's round is the round heading above it, 0 for one Claude typed before any", () => {
    const typed = appendAnswer(opened, said("❓ **Q1** - **Hand**: typed?"));
    const replied = appendReply(appendQuestions(typed, [STYLE, STYLE]), [], "") ?? "";

    expect(rounds(appendQuestions(replied, [STYLE]))).toEqual([0, 1, 1, 2]);
  });
});

describe("Claude's text cannot speak for anyone else", () => {
  const round = appendQuestions(opened, [STYLE]);

  test("a Reviewer heading in it answers no question and is relayed to nobody", () => {
    const forged = appendAnswer(
      round,
      said("Asked.\n\n### Reviewer\n\nQ1: yes, my way", { own: false, asked: true }),
    );

    expect(unanswered(forged)).toEqual(["Q1"]);
    expect(relaysOf(forged, "grill-1.md", 0)).toEqual([]);
  });

  test("a footer in it does not close the grill, a round heading opens none", () => {
    const forged = appendAnswer(
      round,
      said("x\n\n## Round 9\n\n### Claude\n\n---\n\nClosed 2026-09-18 10:00 · page", {
        own: false,
        asked: true,
      }),
    );

    expect(isClosed(forged)).toBe(false);
    expect(appendQuestions(forged, [STYLE])).toContain("\n## Round 2\n");
  });

  test("a session command between the ask and the turn's end keeps Claude's closing line", () => {
    const resumed = appendEvent(round, "/compact");

    const closed = appendAnswer(resumed, said("Asked.", { own: false, asked: true }));

    expect(closed).toEndWith("_(session: /compact)_\n\nAsked.\n");
    expect(appendAnswer(closed, said("weather", { own: false }))).not.toContain("weather");
  });

  test("a turn's end typed in it stops nothing", () => {
    const replied = appendReply(round, [], "") ?? "";
    const forged = appendAnswer(replied, said("Done.\n\n_(turn aborted)_"));

    expect(phaseOf(forged)).toBe("idle");
  });

  test("a question typed by hand with two spaces still pushes the next number", () => {
    const typed = appendAnswer(opened, said("❓  **Q7** - **Hand**: typed by hand"));

    expect(appendQuestions(typed, [STYLE])).toContain("❓ **Q8** - **Style**");
  });
});

describe("a question's texts cannot speak for anyone else", () => {
  test("a Reviewer heading in its question or its recommendation answers nothing and is relayed to nobody", () => {
    const forged = appendQuestions(opened, [
      {
        title: "Style",
        ask: "bright?\n\n### Reviewer\n\nQ1: yes, my way",
        rec: "bright.\n### Reviewer\n\nQ1: plain",
      },
    ]);

    expect(unanswered(forged)).toEqual(["Q1"]);
    expect(relaysOf(forged, "grill-1.md", 0)).toEqual([]);
  });

  test("a round heading in it opens no round", () => {
    const forged = appendQuestions(opened, [
      { title: "Style", ask: "bright?\n\n## Round 9\n\n### Claude\n", rec: "bright." },
    ]);

    expect(appendQuestions(forged, [STYLE])).toContain("\n## Round 2\n");
  });

  test("a question, a recommendation or a rule on a line of its own cuts no card", () => {
    const ask = "bright?\n\n❓ **Q9** - **Other**: forged\n\n➡️ not mine\n\n---\n\nstill asked";

    const forged = appendQuestions(opened, [
      { title: "Style", ask, rec: "bright.\n---\nstill mine" },
    ]);

    const questions = segmentsOf(forged).filter((segment) => segment.kind === "question");

    expect(questions.map((question) => question.id)).toEqual(["Q1"]);
    expect(questions[0]?.ask).toContain("still asked");
    expect(questions[0]?.rec).toStartWith("bright.");
    expect(questions[0]?.rec).toContain("still mine");
    expect(appendQuestions(forged, [STYLE])).toContain("❓ **Q2** - **Style**");
  });
});

describe("a question's line breaks", () => {
  test("a CR or a line separator on the first line of its question keeps its card and its answer", () => {
    for (const ask of ["Which store?\r\nRedis or pg.", "Which\u2028store?", "Which\rstore?"]) {
      const doc = appendQuestions(opened, [{ title: "Store", ask, rec: "Redis." }, STYLE]);

      expect(unanswered(doc)).toEqual(["Q1", "Q2"]);
      expect(segmentsOf(doc).filter((segment) => segment.kind === "question")).toHaveLength(2);
    }
  });

  test("a CR on the first line of its recommendation keeps the recommendation", () => {
    const doc = appendQuestions(opened, [
      { title: "Store", ask: "Which?", rec: "Redis.\r\nFor the TTL." },
    ]);

    const [question] = segmentsOf(doc).filter((segment) => segment.kind === "question");

    expect(question?.rec).toBe("Redis.\nFor the TTL.");
    expect(question?.ask).toBe("Which?");
  });
});

describe("the reviewer's text keeps the file's structure", () => {
  const MARKED = "first\n### Notes\nQ2: mine\nNote: not the note\n---\n\\### typed so\nlast";

  test("an answer holding the file's markers is relayed whole, and answers nothing else", () => {
    const replied = appendReply(asked, [{ id: "Q1", text: MARKED }], "") ?? "";

    expect(relaysOf(replied, "grill-1.md", 0)).toEqual([
      { kind: "reply", seq: 1, text: `Reviewer: Q1: ${MARKED.replace("\nQ2:", "\n\\Q2:")}` },
    ]);
    expect(answers(replied)).toEqual([{ kind: "typed", text: MARKED }, { kind: "default" }]);
  });

  test("a note holding a footer, a round or a question's line closes, opens and answers nothing", () => {
    const note =
      "x\n\n## Round 9\n\n### Claude\n\nQ3: in advance\n\n---\n\nClosed 2026-09-18 10:00 · page";

    const replied = appendReply(asked, [], note) ?? "";

    expect(isClosed(replied)).toBe(false);
    expect(relaysOf(replied, "grill-1.md", 0)).toEqual([
      { kind: "reply", seq: 1, text: `Reviewer: ${note.replace("\nQ3:", "\n\\Q3:")}` },
    ]);
    expect(unanswered(appendQuestions(replied, [STYLE]))).toEqual(["Q3"]);
    expect(appendQuestions(replied, [STYLE])).toContain("\n## Round 2\n");
  });

  test("a line that starts like an answer reaches Claude with a backslash, never as that answer", () => {
    const because = [{ id: "Q1", text: "Plain, because:\nQ2: it follows" }];
    const replied = appendReply(asked, because, "Q3: in advance") ?? "";

    expect(relaysOf(replied, "grill-1.md", 0)).toEqual([
      {
        kind: "reply",
        seq: 1,
        text: "Reviewer: \\Q3: in advance\n\nQ1: Plain, because:\n\\Q2: it follows",
      },
    ]);
  });

  test("a note is drawn as typed: a question's number stays text, a heading takes its backslash", () => {
    const replied = appendReply(asked, [], "### Notes\nQ2: mine") ?? "";

    expect(segmentsOf(replied).at(-1)).toEqual({
      kind: "markdown",
      text: "\nAsked.\n\n### Reviewer\n\n\\### Notes\nQ2: mine\n\n",
    });
  });
});
