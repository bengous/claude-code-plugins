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
import { GRILL_FILE, grillRoutes, openState } from "./fixtures/grill-routes.ts";

tier("user");

const ASK = "mcp__vellum__grill_ask";

// SAFETY: the generated contract's tool names predate AskUserQuestion, which the engine raises
// `tool.call` for all the same; the cast borrows the MCP name type, whose input is open, and changes no value.
const ASK_USER = "AskUserQuestion" as `mcp__${string}__${string}`;

const Q = [["Tool names", "Prefix the tools with the extension's id?", "Yes."]];

describe("the reviewer's rounds reach Claude", () => {
  test("the opening is relayed once, as what the gesture means", async ($, on) => {
    const seen = world(
      on,
      grillRoutes(() => openState(0, "")),
    );

    await $.skill.prompt(START_PROMPT);
    await tick(seen);
    await tick(seen);

    expect(seen.prompts).toEqual([
      expect.stringMatching(
        /^The reviewer opened a grill in .+grill-1\.md on: auth\. Read .+\/src\/extensions\/grill\/grilling\.md, then ask the first round with mcp__vellum__grill_ask\.$/u,
      ),
    ]);
    expect(seen.store.get(`grill:${SESSION_ID}`)).toEqual({ file: GRILL_FILE, round: 0 });
  });

  test("a reloaded module does not relay the opening again", async ($, on) => {
    const seen = world(on, {
      ...grillRoutes(() => openState(0, "")),
      stored: { ...storedSession(), [`grill:${SESSION_ID}`]: { file: GRILL_FILE, round: 0 } },
    });

    await $.session.start(SESSION);
    await tick(seen);

    expect(seen.prompts).toEqual([]);
  });

  test("an answered round is relayed once, as the reviewer wrote it", async ($, on) => {
    let round = 0;

    const seen = world(
      on,
      grillRoutes(() => openState(round, `round ${round}`)),
    );

    await $.skill.prompt(START_PROMPT);
    await tick(seen);
    round = 1;
    await tick(seen);
    await tick(seen);

    expect(seen.prompts.slice(1)).toEqual(["round 1"]);
  });

  test("a dropped round is not remembered, so the next tick retries", async ($, on) => {
    const seen = world(
      on,
      grillRoutes(() => openState(2, "Q1: yes")),
    );

    await $.skill.prompt(START_PROMPT);
    seen.drop = "busy";
    await tick(seen);
    seen.drop = undefined;
    await tick(seen);

    expect(seen.prompts).toEqual(["Q1: yes"]);
  });
});

/** `GET state` once the last grill of the directory is closed, by whom the footer says. */
function ended(reason: string) {
  return { kind: "none", suggestion: null, closed: { file: GRILL_FILE, reason } };
}

describe("a grill the reviewer ended from the page", () => {
  const told = { [`grill:${SESSION_ID}`]: { file: GRILL_FILE, round: 2 } };

  test("is told to Claude once, as the fact alone, and the path goes to the log", async ($, on) => {
    const seen = world(on, { ...grillRoutes(() => ended("page")), stored: told });

    await $.skill.prompt(START_PROMPT);
    await tick(seen);
    await tick(seen);

    expect(seen.prompts).toEqual(["The reviewer ended the grill."]);
    expect(seen.logs.at(-1)).toBe(`grill closed from the page; ${GRILL_FILE} is kept`);
  });

  test("an end the session caused itself is not told", async ($, on) => {
    const seen = world(on, { ...grillRoutes(() => ended("stop")), stored: told });

    await $.skill.prompt(START_PROMPT);
    await tick(seen);

    expect(seen.prompts).toEqual([]);
  });

  test("a session that relayed no round of that grill hears nothing of it", async ($, on) => {
    const seen = world(
      on,
      grillRoutes(() => ended("page")),
    );

    await $.skill.prompt(START_PROMPT);
    await tick(seen);

    expect(seen.prompts).toEqual([]);
  });
});

describe("grill_ask", () => {
  test("a tool $.tool.register registered is served by the unmatched tool.call hook", async ($, on) => {
    const grill = grillRoutes(() => openState(1, "x"), {
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
      grillRoutes(() => ({ kind: "none" }), { ask: () => reply(409, { error: "none" }) }),
    );

    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({
      deny: "no grill open: suggest one with mcp__vellum__grill_suggest",
    });
  });

  test("a round that is not made of triples is refused before it reaches the server", async ($, on) => {
    const grill = grillRoutes(() => openState(1, "x"));
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
    const grill = grillRoutes(() => ({ kind: "none" }));
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
      grillRoutes(() => openState(1, "x"), open),
    );
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: SUGGEST, ...IDEA })).toEqual({
      deny: "grill-1.md is open: ask with mcp__vellum__grill_ask",
    });
  });
});

describe("what the transcript hears of the session", () => {
  test("a session command is kept as an event; what is typed in the terminal is not the grill's", async ($, on) => {
    const grill = grillRoutes(() => ({ kind: "none" }));
    world(on, grill);
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "go on", wait: false, origin: { kind: "composer" } });
    await $.prompt.submit({ text: "/compact", wait: false, origin: { kind: "composer" } });

    expect(grill.posted).toEqual([["event", JSON.stringify({ command: "/compact" })]]);
  });

  test("a round vellum relays is not written again: the server already holds it", async ($, on) => {
    const grill = grillRoutes(() => openState(2, "Q1: yes"));
    const seen = world(on, grill);
    await $.skill.prompt(START_PROMPT);
    await tick(seen);

    await $.prompt.submit({ text: "/x", wait: false, origin: { kind: "plugin", name: "vellum" } });

    expect(seen.prompts).toEqual(["Q1: yes", "/x"]);
    expect(grill.posted).toEqual([]);
  });

  test("the main loop's final text is written, an interrupted turn too", async ($, on) => {
    const grill = grillRoutes(() => ({ kind: "none" }));
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_ANSWERED);
    await $.turn.complete(TURN_ABORTED);

    expect(grill.posted.map(([, body]) => body)).toEqual([
      JSON.stringify({ text: "done", reason: "answer" }),
      JSON.stringify({ text: "done", reason: "aborted" }),
    ]);
  });

  test("a subagent's turn is not", async ($, on) => {
    const grill = grillRoutes(() => ({ kind: "none" }));
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
    const grill = grillRoutes(() => ({ kind: "none" }));
    world(on, grill);
    await $.skill.prompt(START_PROMPT);
    await $.skill.prompt(STOP_PROMPT);
    await $.skill.prompt(STOP_PROMPT);

    expect(grill.posted).toEqual([["close", JSON.stringify({ reason: "stop" })]]);
  });

  test("an approval closes nothing from here: the server ended the grill at the rename", async ($, on) => {
    const grill = grillRoutes(() => ({ kind: "none" }));

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
