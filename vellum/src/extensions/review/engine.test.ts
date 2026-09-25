import { describe, expect, test, tier } from "claude-code/testing";

import type { Route } from "../../core/engine/fixtures/index.ts";
import {
  approved,
  band,
  emit,
  inReview,
  reply,
  SESSION,
  stage,
  START_PROMPT,
  STOP_PROMPT,
  storedSession,
  TURN_ABORTED,
  TURN_ANSWERED,
  TURN_OF_AGENT,
  WORKDIR,
  world,
} from "../../core/engine/fixtures/index.ts";
import { GRACE_MS, LOST, RETRY_MS } from "./engine.ts";
import {
  AGENT_ID,
  agents,
  REQUESTED,
  reviewRoutes,
  RUNNING,
  stoppedResult,
  stops,
} from "./fixtures/review-routes.ts";
import type { Outcome } from "./protocol.ts";

tier("user");

const VERDICT = "## Plan review\n\nStatus: Approved";

const AGENT_ANSWERED = { ...TURN_OF_AGENT, agentId: AGENT_ID, answer: VERDICT };

function ended(seq: number, outcome: Outcome): [string, string] {
  return ["ended", JSON.stringify({ seq, outcome })];
}

const STOPPED: [string, string] = ["stopped", JSON.stringify({ seq: 1 })];

type Gating = { readonly routes: Record<string, Route>; readonly gates: string[] };

/** The body of each `POST /api/gate` the module sent, beside the review's routes. */
function gating(routes: Record<string, Route>): Gating {
  const gates: string[] = [];

  const gate: Route = (body) => {
    gates.push(body ?? "");

    return reply(200, { version: 3, kept: true });
  };

  return { routes: { ...routes, "/api/gate": gate }, gates };
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

  test("an answer the server did not take is posted once more", async ($, on) => {
    let asked = 0;

    const review = reviewRoutes(RUNNING, {
      ended: () => {
        asked += 1;

        return asked === 1 ? null : reply(204, null);
      },
    });

    const seen = world(on, review);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    const answered = $.turn.complete(AGENT_ANSWERED);
    await seen.clock.settle();
    await seen.clock.advance(RETRY_MS);
    await answered;

    expect(review.posted).toEqual([
      ended(1, { kind: "answer", text: VERDICT }),
      ended(1, { kind: "answer", text: VERDICT }),
    ]);
  });

  test("an answer the server failed to take is posted once more, then logged", async ($, on) => {
    const review = reviewRoutes(RUNNING, { ended: () => reply(500, { error: "disk full" }) });
    const seen = world(on, review);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    const answered = $.turn.complete(AGENT_ANSWERED);
    await seen.clock.settle();
    await seen.clock.advance(RETRY_MS);
    await answered;

    expect(review.posted.map(([name]) => name)).toEqual(["ended", "ended"]);
    expect(seen.logs.filter((line) => line.includes("did not take"))).toEqual([
      "the review server did not take the end of plan review 1: 500",
    ]);
  });

  test("an agent killed fails the run at the next stage line", async ($, on) => {
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
  test("/vellum:stop closes the run, then stops its agent", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    world(on, review);
    const before: string[][] = [];

    const asked = stops(on, (agentId) => {
      before.push(review.posted.map(([name]) => name));

      return stoppedResult(agentId);
    });

    await $.skill.prompt(START_PROMPT);
    await $.skill.prompt(STOP_PROMPT);

    expect([asked, before]).toEqual([[AGENT_ID], [["close"]]]);
    expect(review.posted).toEqual([["close", "{}"], STOPPED]);
  });

  test("the approval closes the run and stops its agent, the server still up", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    const seen = world(on, review);
    const asked = stops(on);
    await $.skill.prompt(START_PROMPT);
    emit(seen, approved(3));
    await seen.clock.settle();

    expect(asked).toEqual([AGENT_ID]);
    expect(review.posted).toEqual([["close", "{}"], STOPPED]);
  });
});

/** No run, and the agent of run 1 to stop. */
function listing(): ReturnType<typeof reviewRoutes> {
  const review = reviewRoutes(null);
  review.state = { ...review.state, stopping: [{ seq: 1, agentId: AGENT_ID }] };

  return review;
}

/** No run, and `plan.md` to submit again: a run held the review. */
function resubmitting(): ReturnType<typeof reviewRoutes> {
  const review = reviewRoutes(null);
  review.state = { ...review.state, resubmit: true };

  return review;
}

describe("the agents to stop", () => {
  test("each one listed is stopped with TaskStop, then leaves the list", async ($, on) => {
    const review = listing();
    const seen = world(on, review);
    agents(on);
    const asked = stops(on);
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();

    expect(asked).toEqual([AGENT_ID]);
    expect(review.posted).toEqual([STOPPED]);
  });

  test("a stop denied keeps the agent listed, logged once, and is tried again at the next stage line", async ($, on) => {
    const review = listing();
    const seen = world(on, review);
    agents(on).listed = [{ id: AGENT_ID, description: "d", type: "t", status: "running" }];
    const asked = stops(on, () => ({ deny: "not now" }));
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)), stage(inReview(3)));
    await seen.clock.settle();

    expect(asked).toEqual([AGENT_ID, AGENT_ID]);
    expect(review.posted).toEqual([]);
    expect(seen.logs.filter((line) => line.includes("is not stopped"))).toEqual([
      "the plan reviewer of review 1 is not stopped: TaskStop was denied: not now",
    ]);
  });

  test("a stop whose confirmation the server does not take still lets the requested run launch", async ($, on) => {
    const review = reviewRoutes({ ...REQUESTED, seq: 2 }, { stopped: () => null });
    review.state = { ...review.state, stopping: [{ seq: 1, agentId: "a0" }] };
    const seen = world(on, review);
    const spawned = agents(on);
    stops(on);
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();

    expect(spawned.spawned).toHaveLength(1);
  });

  test("a stop that errs on an agent the engine no longer runs is confirmed", async ($, on) => {
    const review = listing();
    const seen = world(on, review);
    agents(on).listed = [{ id: AGENT_ID, description: "d", type: "t", status: "killed" }];

    stops(on, (agentId) => ({
      result: `Error: Task ${agentId} is not running (status: killed)`,
      text: "not running",
      isError: true,
    }));

    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();

    expect(review.posted).toEqual([STOPPED]);
  });
});

describe("a run whose agent the engine no longer runs", () => {
  test("gone, it keeps the review for the grace, then fails if it still does", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    const seen = world(on, review);
    agents(on);
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)), stage(inReview(3)));
    await seen.clock.settle();
    await seen.clock.advance(GRACE_MS - 1);

    expect(review.posted).toEqual([]);
    await seen.clock.advance(1);

    expect(review.posted).toEqual([ended(1, { kind: "failed", why: LOST })]);
  });

  test("an agent running again when the grace runs out keeps its run", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    const seen = world(on, review);
    const listed = agents(on);
    listed.listed = [{ id: AGENT_ID, description: "d", type: "t", status: "pending" }];
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();
    listed.listed = [{ id: AGENT_ID, description: "d", type: "t", status: "running" }];
    await seen.clock.advance(GRACE_MS);

    expect(review.posted).toEqual([]);
  });

  test("closing ends a grace under way: nothing is asked of a server the mode left", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    let closed = false;
    const state: Route = () => (closed ? null : reply(200, review.state));
    const seen = world(on, { routes: { ...review.routes, "/api/x/review/state": state } });
    agents(on);
    stops(on);
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();
    await $.skill.prompt(STOP_PROMPT);
    closed = true;
    await seen.clock.advance(GRACE_MS);

    expect(seen.logs.filter((line) => line.includes("review"))).toEqual([]);
  });

  test("completed, its answer that lands within the grace is the run's end, and the grace fails nothing", async ($, on) => {
    const review = reviewRoutes(RUNNING);
    const seen = world(on, review);
    agents(on).listed = [{ id: AGENT_ID, description: "d", type: "t", status: "completed" }];
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();
    await $.turn.complete(AGENT_ANSWERED);
    await seen.clock.advance(GRACE_MS);

    expect(review.posted).toEqual([ended(1, { kind: "answer", text: VERDICT })]);
  });
});

describe("a version Claude wrote while a run held the review", () => {
  test("is gated with keep at the next stage line once Claude is at rest, then resubmitted", async ($, on) => {
    const review = resubmitting();
    const { routes, gates } = gating(review.routes);
    const seen = world(on, { routes });
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_ANSWERED);
    gates.length = 0;
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();

    expect(gates).toEqual([JSON.stringify({ unchanged: "keep" })]);
    expect(review.posted).toEqual([["resubmitted", "{}"]]);
  });

  test("a gate the server refuses leaves it to submit again", async ($, on) => {
    const review = resubmitting();

    const refused = reply(409, {
      error: "grill 1 is open: plan.md is recorded as the next version once it ends, if it changed",
    });

    const seen = world(on, { routes: { ...review.routes, "/api/gate": () => refused } });
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_ANSWERED);
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();

    expect(review.posted).toEqual([]);
  });

  test("waits while a turn runs, and after a turn cut short", async ($, on) => {
    const review = resubmitting();
    const { routes, gates } = gating(review.routes);
    const seen = world(on, { routes });
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_ANSWERED);
    await $.turn.start({ text: "go on", turnId: "t2" });
    gates.length = 0;
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();
    await $.turn.complete({ ...TURN_ABORTED, turnId: "t2" });
    seen.children[0]?.write(stage(inReview(3)));
    await seen.clock.settle();

    expect(gates).toEqual([]);
    expect(review.posted).toEqual([]);
  });
});
