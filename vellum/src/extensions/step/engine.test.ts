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

const GONE = "The review server restarted and lost this proposal: propose again.";

const ANSWER_BY_PROMPT =
  "The reviewer's answer will arrive as a prompt, once they send it. End your turn.";

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

  test("a proposal the server does not know, the server restarted, says to propose again", async ($, on) => {
    world(on, stepRoutes({ wait: () => reply(200, { kind: "gone" }) }));
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({ deny: GONE });
  });

  test("a wait that fails is asked once more at once: a revived server's gone says to propose again", async ($, on) => {
    const waits = [null, reply(200, { kind: "gone" })];
    const step = stepRoutes({ wait: () => waits.shift() ?? null });
    world(on, step);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({ deny: GONE });
    expect(step.posted.filter(([name]) => name === "wait")).toHaveLength(2);
  });

  test("a wait that fails twice says the pick comes as a prompt, never a permission prompt", async ($, on) => {
    world(on, stepRoutes({ wait: () => null }));
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({ result: ANSWER_BY_PROMPT });
  });

  test("an approval during the wait says no step follows", async ($, on) => {
    world(on, stepRoutes({ wait: () => reply(200, { kind: "ended", why: "approved" }) }));
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({
      result: "The reviewer approved the plan: no step follows. End your turn.",
    });
  });

  test("a newer proposal that replaced this one says where its answer goes", async ($, on) => {
    world(on, stepRoutes({ wait: () => reply(200, { kind: "ended", why: "replaced" }) }));
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: PROPOSE, ...PROPOSAL })).toEqual({
      deny: "A newer proposal replaced this one; its answer goes to that call.",
    });
  });

  test("a refusal reaches the model as the server said it, and nothing waits", async ($, on) => {
    const held = "grill 1 is open: no step is proposed until it ends";
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
