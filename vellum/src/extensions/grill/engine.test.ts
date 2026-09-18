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
import { GRILL_FILE, grillRoutes, openState } from "./fixtures/grill-routes.ts";

tier("user");

const ASK = "mcp__vellum__grill_ask";

const Q = [["Tool names", "Prefix the tools with the extension's id?", "Yes."]];

describe("the reviewer's rounds reach Claude", () => {
  test("the opening is relayed once, as what the gesture means", async ($, on) => {
    const seen = world(
      on,
      grillRoutes(() => openState(1, "Grill me on: auth")),
    );

    await $.skill.prompt(START_PROMPT);
    await tick(seen);
    await tick(seen);

    expect(seen.prompts).toEqual([
      expect.stringMatching(
        /^The reviewer opened a grill in .+grill-1\.md on: auth\. Read .+\/src\/extensions\/grill\/grilling\.md, then ask the first round with mcp__vellum__grill_ask\.$/u,
      ),
    ]);
    expect(seen.store.get(`grill:${SESSION_ID}`)).toEqual({ file: GRILL_FILE, round: 1 });
  });

  test("a reloaded module does not relay the opening again", async ($, on) => {
    const seen = world(on, {
      ...grillRoutes(() => openState(1, "Grill me on: auth")),
      stored: { ...storedSession(), [`grill:${SESSION_ID}`]: { file: GRILL_FILE, round: 1 } },
    });

    await $.session.start(SESSION);
    await tick(seen);

    expect(seen.prompts).toEqual([]);
  });

  test("an answered round is relayed once, as the reviewer wrote it", async ($, on) => {
    let round = 1;

    const seen = world(
      on,
      grillRoutes(() => openState(round, `round ${round}`)),
    );

    await $.skill.prompt(START_PROMPT);
    await tick(seen);
    round = 2;
    await tick(seen);
    await tick(seen);

    expect(seen.prompts.slice(1)).toEqual(["round 2"]);
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
