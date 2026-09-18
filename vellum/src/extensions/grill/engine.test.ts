import { describe, expect, test, tier } from "claude-code/testing";

import {
  reply,
  SESSION,
  SESSION_ID,
  START_PROMPT,
  storedSession,
  tick,
  world,
} from "../../core/engine/fixtures/index.ts";
import {
  approved,
  STOP_PROMPT,
  TURN_ABORTED,
  TURN_ANSWERED,
  TURN_OF_AGENT,
} from "../../core/engine/fixtures/index.ts";
import {
  endedGrill,
  GRILL_NAME,
  grillRoutes,
  NO_GRILL,
  openGrill,
} from "./fixtures/grill-routes.ts";
import type { Relay } from "./protocol.ts";

tier("user");

const ASK = "mcp__vellum__grill_ask";

// SAFETY: the generated contract's tool names predate AskUserQuestion, which the engine raises
// `tool.call` for all the same; the cast borrows the MCP name type, whose input is open, and changes no value.
const ASK_USER = "AskUserQuestion" as `mcp__${string}__${string}`;

const VELLUM = { kind: "plugin", name: "vellum" } as const;

const COMPOSER = { kind: "composer" } as const;

const TURN = { text: "Reviewer: x", turnId: "t1" };

const TYPED_TURN = { text: "and the weather?", turnId: "t2" };

const TYPED_ANSWERED = { ...TURN_ANSWERED, turnId: "t2" };

const Q = [["Tool names", "Prefix the tools with the extension's id?", "Yes."]];

const CURSOR = `grill:${SESSION_ID}`;

describe("the reviewer's entries reach Claude", () => {
  test("the first opening of a session names the file, the subject and the guide, once", async ($, on) => {
    const seen = world(
      on,
      grillRoutes(() => openGrill()),
    );

    await $.skill.prompt(START_PROMPT);
    await tick(seen);
    await tick(seen);

    expect(seen.prompts).toEqual([
      expect.stringMatching(
        /^The reviewer opened grill-1\.md on: auth\. Read .+\/src\/extensions\/grill\/grilling\.md, then ask with mcp__vellum__grill_ask\.$/u,
      ),
    ]);
    expect(seen.store.get(CURSOR)).toEqual({ file: GRILL_NAME, seq: 0, taught: true });
  });

  test("a later grill of the session names no guide: Claude read it", async ($, on) => {
    const second: Relay = { kind: "opened", seq: 0, name: "grill-2.md", subject: "cache" };

    const seen = world(on, {
      ...grillRoutes(() => ({ open: true, relays: [second] })),
      stored: { ...storedSession(), [CURSOR]: { file: GRILL_NAME, seq: 3, taught: true } },
    });

    await $.session.start(SESSION);
    await tick(seen);

    expect(seen.prompts).toEqual(["The reviewer opened grill-2.md on: cache."]);
    expect(seen.store.get(CURSOR)).toEqual({ file: "grill-2.md", seq: 0, taught: true });
  });

  test("a reloaded module does not relay the opening again", async ($, on) => {
    const seen = world(on, {
      ...grillRoutes(() => openGrill()),
      stored: { ...storedSession(), [CURSOR]: { file: GRILL_NAME, seq: 0, taught: true } },
    });

    await $.session.start(SESSION);
    await tick(seen);

    expect(seen.prompts).toEqual([]);
  });

  test("two replies before one poll both go out, in order, as the server worded them", async ($, on) => {
    let grill = openGrill();

    const seen = world(
      on,
      grillRoutes(() => grill),
    );

    await $.skill.prompt(START_PROMPT);
    await tick(seen);
    grill = openGrill("Reviewer: and hurry\n\nQ1: plain", "Reviewer: one more thing");
    await tick(seen);
    await tick(seen);

    expect(seen.prompts.slice(1)).toEqual([
      "Reviewer: and hurry\n\nQ1: plain",
      "Reviewer: one more thing",
    ]);
    expect(seen.store.get(CURSOR)).toMatchObject({ seq: 2 });
  });

  test("a dropped entry does not move the cursor, so the next tick retries", async ($, on) => {
    const seen = world(on, {
      ...grillRoutes(() => openGrill("Reviewer: Q1: yes")),
      stored: { ...storedSession(), [CURSOR]: { file: GRILL_NAME, seq: 0, taught: true } },
    });

    await $.session.start(SESSION);
    seen.drop = "busy";
    await tick(seen);
    seen.drop = undefined;
    await tick(seen);

    expect(seen.prompts).toEqual(["Reviewer: Q1: yes"]);
  });
});

describe("a grill the reviewer ended from the page", () => {
  const told = { ...storedSession(), [CURSOR]: { file: GRILL_NAME, seq: 1, taught: true } };

  test("is told once and names the file; the path goes to the log", async ($, on) => {
    const seen = world(on, { ...grillRoutes(() => endedGrill("Reviewer: x")), stored: told });

    await $.session.start(SESSION);
    await tick(seen);
    await tick(seen);

    expect(seen.prompts).toEqual(["The reviewer ended grill-1.md."]);
    expect(seen.logs.at(-1)).toBe("grill closed from the page; grill-1.md is kept");
  });

  test("the end goes after the replies still due", async ($, on) => {
    const grill = endedGrill("Reviewer: x", "Reviewer: last word");
    const seen = world(on, { ...grillRoutes(() => grill), stored: told });

    await $.session.start(SESSION);
    await tick(seen);

    expect(seen.prompts).toEqual(["Reviewer: last word", "The reviewer ended grill-1.md."]);
  });

  test("an end the session caused itself is not told", async ($, on) => {
    const stopped = { open: false, relays: openGrill("Reviewer: x").relays };
    const seen = world(on, { ...grillRoutes(() => stopped), stored: told });

    await $.session.start(SESSION);
    await tick(seen);

    expect(seen.prompts).toEqual([]);
  });

  test("a session that relayed nothing of that grill hears nothing of it", async ($, on) => {
    const seen = world(
      on,
      grillRoutes(() => endedGrill("Reviewer: x")),
    );

    await $.skill.prompt(START_PROMPT);
    await tick(seen);

    expect(seen.prompts).toEqual([]);
  });
});

describe("the status under the prompt", () => {
  test("says where to answer while a grill is open, once, and goes back to planning after it", async ($, on) => {
    let grill = openGrill();

    const seen = world(
      on,
      grillRoutes(() => grill),
    );

    await $.skill.prompt(START_PROMPT);
    await tick(seen);
    await tick(seen);

    expect(seen.statuses).toEqual(["planning", "grill open, answer in the page"]);
    grill = endedGrill();
    await tick(seen);

    expect(seen.statuses.at(-1)).toBe("planning");
  });
});

describe("grill_ask", () => {
  test("a tool $.tool.register registered is served by the unmatched tool.call hook", async ($, on) => {
    const grill = grillRoutes(() => openGrill("Reviewer: x"), {
      ask: () => reply(200, { first: 3, last: 3 }),
    });

    const seen = world(on, grill);
    await $.session.start(SESSION);
    await $.skill.prompt(START_PROMPT);

    expect(seen.tools).toContain("grill_ask");
    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({
      result:
        'Asked Q3–Q3, in order. End your turn in one short line; answers arrive as "Qn: ..." lines.',
    });
    expect(grill.posted).toEqual([["ask", JSON.stringify({ q: Q })]]);
  });

  test("with no grill open it is refused, and names the way to one", async ($, on) => {
    world(
      on,
      grillRoutes(() => NO_GRILL, { ask: () => reply(409, { error: "no grill is open" }) }),
    );

    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({
      deny: "no grill open: suggest one with mcp__vellum__grill_suggest",
    });
  });

  test('a refusal that is not "no grill" reaches the model as the server said it', async ($, on) => {
    const gone = { ask: () => reply(409, { error: "the plan's directory is gone" }) };
    world(
      on,
      grillRoutes(() => NO_GRILL, gone),
    );
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({
      deny: "the plan's directory is gone",
    });
  });

  test("a round that is not made of triples is refused before it reaches the server", async ($, on) => {
    const grill = grillRoutes(() => openGrill("Reviewer: x"));
    world(on, grill);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: [["only a title"]] })).toMatchObject({
      deny: expect.stringContaining("[title, question, recommendation]"),
    });
    expect(grill.posted).toEqual([]);
  });

  test("outside the mode it names the way in", async ($, on) => {
    world(on);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({
      deny: "no vellum planning in progress; run /vellum:start",
    });
  });
});

describe("grill_suggest", () => {
  const SUGGEST = "mcp__vellum__grill_suggest";

  const IDEA = { subject: "auth", reason: "three choices change the contract" };

  test("hands the subject and the reason to the page, and ends the turn", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: SUGGEST, ...IDEA })).toEqual({
      result: "Suggested. End your turn; the reviewer opens the grill from the page.",
    });
    expect(grill.posted).toEqual([["suggest", JSON.stringify(IDEA)]]);
  });

  test("is refused while a grill is open, and names the tool to ask with", async ($, on) => {
    const open = { suggest: () => reply(409, { error: "grill-1.md is open" }) };
    world(
      on,
      grillRoutes(() => openGrill("Reviewer: x"), open),
    );
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: SUGGEST, ...IDEA })).toEqual({
      deny: "grill-1.md is open: ask with mcp__vellum__grill_ask",
    });
  });
});

describe("what the transcript hears of the session", () => {
  test("a session command is kept as an event; what is typed in the terminal is not the grill's", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "go on", wait: false, origin: { kind: "composer" } });
    await $.prompt.submit({ text: "/compact", wait: false, origin: { kind: "composer" } });

    expect(grill.posted).toEqual([["event", JSON.stringify({ command: "/compact" })]]);
  });

  test("an entry vellum relays is not written again: the server already holds it", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    const seen = world(on, grill);
    await $.skill.prompt(START_PROMPT);

    await $.prompt.submit({ text: "/x", wait: false, origin: VELLUM });

    expect(seen.prompts).toEqual(["/x"]);
    expect(grill.posted).toEqual([]);
  });

  test("a turn a vellum relay started is the grill's own, an interrupted one too", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "Reviewer: x", wait: false, origin: VELLUM });
    await $.turn.start(TURN);
    await $.turn.complete(TURN_ABORTED);

    expect(grill.posted).toEqual([
      ["answer", JSON.stringify({ text: "done", reason: "aborted", own: true })],
    ]);
  });

  test("the transcript gets the turn's answer, not what another plugin shows beneath it", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", () => ({ text: "TL;DR of a peer plugin" }));
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "Reviewer: x", wait: false, origin: VELLUM });
    await $.turn.start({ text: "Reviewer: x", turnId: "t1" });
    await $.turn.complete(TURN_ANSWERED);

    expect(grill.posted).toEqual([
      ["answer", JSON.stringify({ text: "done", reason: "answer", own: true })],
    ]);
  });

  test("a turn the terminal started is not, even typed over a relay's turn", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "Reviewer: x", wait: false, origin: VELLUM });
    await $.turn.start(TURN);
    await $.prompt.submit({ text: "and the weather?", wait: false, origin: COMPOSER });
    await $.turn.complete(TURN_ANSWERED);
    await $.turn.start(TYPED_TURN);
    await $.turn.complete(TYPED_ANSWERED);

    expect(grill.posted.map(([, body]) => body)).toEqual([
      JSON.stringify({ text: "done", reason: "answer", own: true }),
      JSON.stringify({ text: "done", reason: "answer", own: false }),
    ]);
  });

  test("a relay and a typed prompt that enter before either turn: the turn on the typed text is not own", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "Reviewer: x", wait: false, origin: VELLUM });
    await $.prompt.submit({ text: "and the weather?", wait: false, origin: COMPOSER });
    await $.turn.start(TYPED_TURN);
    await $.turn.complete(TYPED_ANSWERED);

    expect(grill.posted).toEqual([
      ["answer", JSON.stringify({ text: "done", reason: "answer", own: false })],
    ]);
  });

  test("/vellum:stop forgets the note: a turn of the next mode is not own", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "Reviewer: x", wait: false, origin: VELLUM });
    await $.skill.prompt(STOP_PROMPT);
    await $.skill.prompt(START_PROMPT);
    await $.turn.start(TURN);
    await $.turn.complete(TURN_ANSWERED);

    expect(grill.posted.at(-1)).toEqual([
      "answer",
      JSON.stringify({ text: "done", reason: "answer", own: false }),
    ]);
  });

  test("a turn with no prompt before it, as after a reload, is not the grill's own", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_ANSWERED);

    expect(grill.posted).toEqual([
      ["answer", JSON.stringify({ text: "done", reason: "answer", own: false })],
    ]);
  });

  test("a subagent's turn is not", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_OF_AGENT);

    expect(grill.posted).toEqual([]);
  });
});

describe("AskUserQuestion", () => {
  test("is refused while live, with the two grill tools named", async ($, on) => {
    world(on);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK_USER, questions: [] })).toEqual({
      deny: "vellum is live: suggest a grill with mcp__vellum__grill_suggest, or ask inside an open grill with mcp__vellum__grill_ask",
    });
  });

  test("passes on outside the mode", async ($, on) => {
    world(on);
    on("tool.call", () => ({ result: "asked" }));

    expect(await $.tool.call({ tool: ASK_USER, questions: [] })).toEqual({
      result: "asked",
    });
  });
});

describe("closing from the session", () => {
  test("/vellum:stop closes the grill once, before the mode", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    await $.skill.prompt(START_PROMPT);
    await $.skill.prompt(STOP_PROMPT);
    await $.skill.prompt(STOP_PROMPT);

    expect(grill.posted).toEqual([["close", JSON.stringify({ reason: "stop" })]]);
  });

  test("an approval closes nothing from here: the server ended the grill at the rename", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);

    const seen = world(on, {
      routes: { ...grill.routes, "/api/pending": () => reply(200, approved(1)) },
    });

    await $.skill.prompt(START_PROMPT);
    await tick(seen);
    await tick(seen);

    expect(seen.prompts).toHaveLength(1);
    expect(grill.posted).toEqual([]);
  });
});
