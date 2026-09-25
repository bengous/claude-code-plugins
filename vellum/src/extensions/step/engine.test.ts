import { describe, expect, test, tier } from "claude-code/testing";

import {
  emit,
  reply,
  sent,
  SESSION,
  START_PROMPT,
  told,
  WORKDIR,
  world,
} from "../../core/engine/fixtures/index.ts";
import { PROPOSED_ID, stepRoutes } from "./fixtures/step-routes.ts";

tier("user");

const PROPOSE = "mcp__vellum__propose";

const PROPOSAL = {
  reason: "Two choices change the interface.",
  moves: [{ kind: "grill", subject: "auth", choices: ["Sessions", "Tokens"] }, { kind: "plan" }],
  recommended: 0,
};

const ACCEPTED = "Accepted: the plan.";

const ANSWERED = { kind: "answered", seq: 1, text: ACCEPTED };

const BATCH = `${WORKDIR}.review/v0.feedback-1.md`;

const LOST =
  "The proposal no longer waits for the reviewer: the review server restarted, or the review moved on. Propose again.";

describe("propose", () => {
  test("waits for the reviewer's answer, returns it, and the answer is not relayed", async ($, on) => {
    const step = stepRoutes({
      wait: () => {
        emit(seen, told(ACCEPTED, "step"));

        return reply(200, ANSWERED);
      },
    });

    const seen = world(on, step);
    await $.session.start(SESSION);
    await $.skill.prompt(START_PROMPT);

    expect(seen.tools).toContain("propose");
    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({ result: ACCEPTED });
    await seen.clock.settle();
    expect(seen.prompts).not.toContain(ACCEPTED);
    expect(step.posted).toEqual([
      ["propose", JSON.stringify(PROPOSAL)],
      ["wait", JSON.stringify({ id: PROPOSED_ID })],
    ]);
  });

  test("an answer whose line lands before the tool's is held for it, and never relayed", async ($, on) => {
    const step = stepRoutes({
      wait: async () => {
        emit(seen, told(ACCEPTED, "step"));
        await seen.clock.sleep(500);

        return reply(200, ANSWERED);
      },
    });

    const seen = world(on, step);
    await $.skill.prompt(START_PROMPT);
    const proposing = $.tool.call({ tool: PROPOSE, ...PROPOSAL });
    await seen.clock.settle();
    await seen.clock.advance(500);

    expect(await proposing).toEqual({ result: ACCEPTED });
    await seen.clock.settle();
    expect(seen.prompts).not.toContain(ACCEPTED);
  });

  test("asks again each time the hold runs out with the proposal still waiting", async ($, on) => {
    const waits = [{ kind: "open" }, { kind: "open" }, ANSWERED];
    const step = stepRoutes({ wait: () => reply(200, waits.shift()) });
    world(on, step);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({ result: ACCEPTED });
    expect(step.posted.filter(([name]) => name === "wait")).toHaveLength(3);
  });

  test("a Send during the wait is relayed as it comes, never returned", async ($, on) => {
    const waits = [{ kind: "open" }, ANSWERED];

    const step = stepRoutes({
      wait: () => {
        if (waits.length === 2) emit(seen, sent(BATCH));

        return reply(200, waits.shift());
      },
    });

    const seen = world(on, step);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({ result: ACCEPTED });
    await seen.clock.settle();
    expect(seen.prompts).toContain(`Reviewer sent: read ${BATCH}.`);
  });

  test("a proposal gone unanswered, the server restarted, says to propose again", async ($, on) => {
    world(on, stepRoutes({ wait: () => reply(200, { kind: "gone" }) }));
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({ deny: LOST });
  });

  test("a wait the server does not answer says to propose again, never a permission prompt", async ($, on) => {
    world(on, stepRoutes({ wait: () => null }));
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({ deny: LOST });
  });

  test("a refusal reaches the model as the server said it, and nothing waits", async ($, on) => {
    const held = "grill 1 is open: no step is proposed until the reviewer ends it";
    const step = stepRoutes({ propose: () => reply(409, { error: held }) });
    world(on, step);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({ deny: held });
    expect(step.posted.map(([name]) => name)).toEqual(["propose"]);
  });

  test("a proposal that is not one is refused before it reaches the server", async ($, on) => {
    const step = stepRoutes();
    world(on, step);
    await $.skill.prompt(START_PROMPT);

    for (const wrong of [
      { ...PROPOSAL, moves: [] },
      { ...PROPOSAL, recommended: 2 },
      { ...PROPOSAL, moves: [{ kind: "grill", subject: "auth\n### Reviewer" }] },
    ]) {
      expect(await $.tool.call({ tool: PROPOSE, ...wrong })).toEqual({
        deny: expect.stringMatching(/^reason, moves and recommended:/u),
      });
    }

    expect(step.posted).toEqual([]);
  });

  test("outside the mode it names the way in", async ($, on) => {
    world(on);

    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({
      deny: "no vellum planning in progress; run /vellum:start",
    });
  });
});
