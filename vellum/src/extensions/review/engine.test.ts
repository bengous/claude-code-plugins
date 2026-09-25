import { describe, expect, test, tier } from "claude-code/testing";

import {
  band,
  inReview,
  SESSION,
  stage,
  START_PROMPT,
  STOP_PROMPT,
  storedSession,
  TURN_ABORTED,
  TURN_OF_AGENT,
  WORKDIR,
  world,
} from "../../core/engine/fixtures/index.ts";
import { AGENT_ID, agents, REQUESTED, reviewRoutes, RUNNING } from "./fixtures/review-routes.ts";
import type { Outcome } from "./protocol.ts";

tier("user");

const VERDICT = "## Plan review\n\nStatus: Approved";

const AGENT_ANSWERED = { ...TURN_OF_AGENT, agentId: AGENT_ID, answer: VERDICT };

function ended(seq: number, outcome: Outcome): [string, string] {
  return ["ended", JSON.stringify({ seq, outcome })];
}

describe("a run the page asked for", () => {
  test("asks the engine once for the reviewer on the version, for two stage lines", async ($, on) => {
    const review = reviewRoutes(REQUESTED);
    const seen = world(on, review);
    const spawned = agents(on);
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)), stage(inReview(3)));
    await seen.clock.settle();

    expect(spawned.spawned).toEqual([
      {
        description: "plan review v3",
        prompt: `Review the plan at ${WORKDIR}.review/v3.md, version 3 of ${WORKDIR}plan.md; its artifacts are the files of ${WORKDIR} it names. No request is given: judge intent against the plan's title and Decisions. Give line numbers of that file.`,
      },
    ]);
  });

  test("a spawn that started no agent ends the run as failed", async ($, on) => {
    const review = reviewRoutes(REQUESTED);
    const seen = world(on, review);
    agents(on);
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();

    expect(review.posted).toEqual([
      ended(1, { kind: "failed", why: "the engine started no agent" }),
    ]);
  });

  test("a launch the engine refuses ends the run as failed, with the reason", async ($, on) => {
    const review = reviewRoutes(REQUESTED);
    const seen = world(on, review);
    agents(on, () => ({ deny: "no agent vellum:plan-reviewer" }));
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();

    expect(review.posted).toEqual([
      ended(1, { kind: "failed", why: "no agent vellum:plan-reviewer" }),
    ]);
  });
});

describe("the agent's end", () => {
  test("its final text is posted as the run's answer", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    world(on, review);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(AGENT_ANSWERED);

    expect(review.posted).toEqual([ended(1, { kind: "answer", text: VERDICT })]);
  });

  test("reaches its run after a reload, before any stage line", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    world(on, { ...review, stored: storedSession() });
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.session.start(SESSION);
    await $.turn.complete(AGENT_ANSWERED);

    expect(review.posted).toEqual([ended(1, { kind: "answer", text: VERDICT })]);
  });

  test("another agent's end posts nothing", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    world(on, review);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete({ ...AGENT_ANSWERED, agentId: "a2" });

    expect(review.posted).toEqual([]);
  });

  test("an end that is no answer fails the run with the engine's reason", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    world(on, review);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete({ ...TURN_ABORTED, agentId: AGENT_ID });

    expect(review.posted).toEqual([ended(1, { kind: "failed", why: "aborted" })]);
  });

  test("an empty answer fails the run", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    world(on, review);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete({ ...AGENT_ANSWERED, answer: " \n" });

    expect(review.posted).toEqual([ended(1, { kind: "failed", why: "no answer" })]);
  });

  test("an agent the engine no longer runs fails the run at the next stage line", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    const seen = world(on, review);
    const listed = agents(on);
    listed.listed = [
      { id: AGENT_ID, description: "d", type: "vellum:plan-reviewer", status: "killed" },
    ];
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();

    expect(review.posted).toEqual([ended(1, { kind: "failed", why: "killed" })]);
  });
});

describe("the band above the prompt", () => {
  test("says a review runs while one does, and nothing once it ended", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    const seen = world(on, review);
    agents(on).listed = [{ id: AGENT_ID, description: "d", type: "t", status: "running" }];
    await $.skill.prompt(START_PROMPT);
    const drawn = await band($);
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();

    expect(await drawn.text()).toBe(
      "vellum │ plan v3 · in review │ review · running │ Review page ↗",
    );
    review.state = { ...review.state, run: null };
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();

    expect(await drawn.text()).toBe("vellum │ plan v3 · in review │ Review page ↗");
  });
});

describe("closing from the session", () => {
  test("/vellum:stop closes the run", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    world(on, review);
    await $.skill.prompt(START_PROMPT);
    await $.skill.prompt(STOP_PROMPT);

    expect(review.posted).toEqual([["close", "{}"]]);
  });
});
