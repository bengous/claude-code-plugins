import { describe, expect, test } from "bun:test";

import type { EventInput, RuleVerdict, Step, Workflow } from "../core/server/domain/workflow.ts";
import {
  next,
  pillOf,
  refusedNow,
  SAMPLE_AT,
  stageOf,
  viewOf,
} from "../core/server/domain/workflow.ts";
import { EMPTY, INVARIANTS, PARTS, proof, returned, TABLE, told, WORDINGS } from "./proof.ts";
import type { Move } from "./step/contract.ts";
import { pendingOf } from "./step/proposal.ts";

function tried(w: Workflow, event: string, input: EventInput = {}): Step {
  return next(w, TABLE, event, input, "engine");
}

/** The workflow after each event in turn, every one of which must pass. */
function play(w: Workflow, ...events: readonly (readonly [string, EventInput])[]): Workflow {
  let now = w;

  for (const [event, input] of events) {
    const step = tried(now, event, input);

    if (step.verdict.kind !== "allow") throw new Error(`${event} refused: ${step.verdict.reason}`);
    now = step.workflow;
  }

  return now;
}

/** The review as a rename that failed leaves it: the version under review, the error in memory. */
function approvalFailed(w: Workflow): Workflow {
  const { workspace } = w;

  if (workspace.kind !== "inReview") throw new Error("no version is under review");

  return { ...w, workspace: { ...workspace, finalizeError: "rename refused" } };
}

const KEEP = { unchanged: "keep" };

const RECORD = { unchanged: "record" };

const PENDING = { plan: "pending" };

const ABSENT = { plan: "absent" };

const COMMENTS = {
  parts: "false",
  edit: "",
  names: "held",
  comments: "true",
  text: "## Comments\n",
};

const OWN_GRILL = {
  id: "",
  answer: JSON.stringify({ kind: "move", move: { kind: "grill", subject: "auth", choices: [] } }),
  move: "grill",
  subject: "auth",
  seq: "1",
  opened: "The reviewer opened grill-1.md on: auth.",
  at: SAMPLE_AT,
};

function proposing(id: string, ...moves: readonly Move[]): EventInput {
  return { id, proposal: JSON.stringify({ reason: "A step is due.", moves, recommended: 0 }) };
}

function picking(id: string, move: Move): EventInput {
  const answer = JSON.stringify({ kind: "move", move });

  return { id, answer, move: move.kind, subject: "", seq: "1", opened: "", at: SAMPLE_AT };
}

const ROUND = { q: JSON.stringify([["Style", "bright or plain?", "I recommend bright."]]) };

const DRAFTED = play(EMPTY, ["planWritten", PENDING]);

const V1 = play(DRAFTED, ["record", KEEP]);

const GRILLING = play(V1, ["answerProposal", OWN_GRILL]);

describe("a grill holds the review (#235)", () => {
  test("the turn's end records nothing under it, and the refusal is journaled with why", () => {
    const step = tried(play(GRILLING, ["planWritten", PENDING]), "record", KEEP);
    const reason = "grill 1 is open: plan.md waits; you are told when it ends";

    expect(step.verdict).toEqual({ kind: "refuse", rule: "held", reason });
    expect(step.effects).toEqual([
      {
        kind: "journal",
        line: {
          actor: "engine",
          event: "record",
          input: KEEP,
          verdict: "refuse",
          rule: "held",
          reason,
        },
      },
    ]);
  });

  test("the pill says it, in drafting as in review, and that plan.md waits", () => {
    expect(pillOf(play(DRAFTED, ["answerProposal", OWN_GRILL])).text).toBe(
      "Held · grill 1 is open · plan.md waits",
    );
    expect(pillOf(GRILLING).text).toBe("Held · grill 1 is open");
  });

  test("End grill with plan.md waiting tells Claude once, and the next turn's end records", () => {
    const waiting = play(GRILLING, ["planWritten", PENDING]);
    const ended = tried(waiting, "endGrill", { reason: "stop", at: SAMPLE_AT });

    expect(told(ended)).toEqual([
      "plan.md changed while grill 1 was open: integrate what it settled, then end your turn.",
    ]);
    expect(tried(ended.workflow, "record", KEEP).effects[0]).toEqual({ kind: "recordVersion" });
  });

  test("what is refused now under it: the version, a proposal, and Approve without a confirmation", () => {
    expect(
      refusedNow(GRILLING, TABLE).map(({ event, effect, reason }) => [event, effect, reason]),
    ).toEqual(
      expect.arrayContaining([
        ["record", "refuse", "grill 1 is open: plan.md waits; you are told when it ends"],
        ["propose", "refuse", "grill 1 is open: no step is proposed until it ends"],
        ["approve", "confirm", "The review is held: grill 1 is open."],
      ]),
    );
    expect(refusedNow(GRILLING, TABLE).some(({ event }) => event === "send")).toBe(false);
  });
});

describe("no plan.md refuses the version, in drafting as in review (F-A1)", () => {
  const WRITE_FIRST = {
    kind: "refuse",
    rule: "no-plan",
    reason: "write plan.md in plans/2026-09-26/wip-4c2a9d93/ first",
  } satisfies RuleVerdict;

  test("while drafting, at the turn's end as through submit", () => {
    expect(tried(EMPTY, "record", KEEP).verdict).toEqual(WRITE_FIRST);
    expect(tried(EMPTY, "record", RECORD).verdict).toEqual(WRITE_FIRST);
  });

  test("once deleted after a version, at the turn's end as through submit", () => {
    const gone = play(V1, ["planWritten", ABSENT]);

    expect(tried(gone, "record", KEEP).verdict).toEqual(WRITE_FIRST);
    expect(tried(gone, "record", RECORD).verdict).toEqual(WRITE_FIRST);
  });

  test("once deleted after a Send, where a version would be recorded", () => {
    const sent = play(V1, ["planWritten", ABSENT], ["send", COMMENTS]);

    expect(tried(sent, "record", RECORD).verdict).toEqual(WRITE_FIRST);
  });
});

describe("a plan review holds the review", () => {
  const RUNNING = play(
    V1,
    ["requestReview", { version: "1" }],
    ["reviewLaunched", { seq: "1", agentId: "agent-1", model: "claude-opus-5-5" }],
  );

  test("a run that fails with plan.md waiting says it ended without a verdict", () => {
    const failed = tried(play(RUNNING, ["planWritten", PENDING]), "reviewDone", {
      seq: "1",
      outcome: "failed",
      why: "aborted",
    });

    expect(told(failed)).toEqual([
      "plan.md changed while plan review 1 of v1 was running, which ended without a verdict: check plan.md, then end your turn.",
    ]);
  });

  test("a verdict with plan.md unchanged tells Claude nothing: it is the reviewer's (P15)", () => {
    const verdict = {
      seq: "1",
      outcome: "answer",
      text: "Fine.",
      file: "reviews/v1.md",
      at: SAMPLE_AT,
    };

    expect(told(tried(RUNNING, "reviewDone", verdict))).toEqual([]);
  });

  test("whyNot's rows come before the hold, the hold's reason alone after (P2)", () => {
    expect(tried(GRILLING, "requestReview", { version: "2" }).verdict).toMatchObject({
      reason: "v1 is under review, not v2",
    });
    expect(tried(GRILLING, "requestReview", { version: "1" }).verdict).toMatchObject({
      reason: "grill 1 is open",
    });
  });
});

describe("the approval", () => {
  const APPROVE = {
    confirmed: "",
    edit: "",
    text: "",
    notes: "",
    dir: "plans/2026-09-26/the-plan/",
    at: SAMPLE_AT,
  };

  test("under a hold asks a confirmation, passes once it names that hold, and asks again for another (P4)", () => {
    expect(tried(GRILLING, "approve", APPROVE).verdict).toMatchObject({
      kind: "confirm",
      reason: "The review is held: grill 1 is open.",
    });
    expect(
      tried(GRILLING, "approve", { ...APPROVE, confirmed: "grill 1 is open" }).verdict.kind,
    ).toBe("allow");
    expect(
      tried(GRILLING, "approve", { ...APPROVE, confirmed: "grill 2 is open" }).verdict.kind,
    ).toBe("confirm");
  });

  test("is refused while plan.md changed since the version, and says to end a hold first (D13)", () => {
    expect(tried(play(V1, ["planWritten", PENDING]), "approve", APPROVE).verdict).toMatchObject({
      rule: "approve-draft",
      reason: "plan.md changed since v1: record it before approving",
    });
    expect(
      tried(play(GRILLING, ["planWritten", PENDING]), "approve", APPROVE).verdict,
    ).toMatchObject({
      reason:
        "plan.md changed since v1 while grill 1 is open: end it, then record plan.md before approving",
    });
  });

  test("closes the grill, and its entry comes after every extension closed theirs", () => {
    const step = tried(GRILLING, "approve", { ...APPROVE, confirmed: "grill 1 is open" });

    expect(step.workflow.regions.filter(({ state }) => state !== "closed")).toEqual([]);
    expect(step.effects.map(({ kind }) => kind)).toEqual([
      "approveDirectory",
      "appendFile",
      "channel",
      "journal",
    ]);
  });

  test("then every event is refused, the gate in its own words (P3)", () => {
    const approved = play(V1, ["approve", APPROVE]);

    expect(tried(approved, "record", KEEP).verdict).toMatchObject({
      reason: "plan v1 is already approved",
    });
    expect(tried(approved, "answerProposal", OWN_GRILL).verdict).toMatchObject({
      reason: "the plan is approved",
    });
  });
});

describe("the plan step (D17)", () => {
  const GRILL_MOVE: Move = { kind: "grill", subject: "auth", choices: [] };

  test("writing plan.md takes the plan out of a waiting proposal, which keeps its other moves", () => {
    const written = play(
      EMPTY,
      ["propose", proposing("p2", { kind: "plan" }, GRILL_MOVE)],
      ["planWritten", PENDING],
    );

    expect(pendingOf(written)?.proposal.moves).toEqual([GRILL_MOVE]);
    expect(pendingOf(written)?.proposal.recommended).toBe(0);
  });

  test("drops a proposal whose one move was the plan, and step.json says why", () => {
    const step = tried(
      play(EMPTY, ["propose", proposing("p1", { kind: "plan" })]),
      "planWritten",
      PENDING,
    );

    expect(pendingOf(step.workflow)).toBeNull();
    expect(step.effects[0]).toMatchObject({ kind: "writeFile", file: ".review/step.json" });
    expect(step.effects[0]).toMatchObject({
      text: expect.stringContaining('"dropped":{"id":"p1","why":"written"}'),
    });
  });

  test("refuses a proposal that offers the plan once plan.md exists", () => {
    expect(tried(DRAFTED, "propose", proposing("p1", { kind: "plan" })).verdict).toEqual({
      kind: "refuse",
      rule: "plan-over-plan",
      reason: "plan.md exists: the plan step is done",
    });
  });

  test("takes a proposal that offers the plan once plan.md is deleted after a version (F-A1)", () => {
    const gone = play(V1, ["planWritten", ABSENT]);

    expect(tried(gone, "propose", proposing("p1", { kind: "plan" })).verdict.kind).toBe("allow");
  });

  test("the reviewer's edit writes plan.md, and drops a proposal whose one move was the plan", () => {
    const offered = play(
      V1,
      ["planWritten", ABSENT],
      ["propose", proposing("p1", { kind: "plan" })],
    );

    const step = tried(offered, "sendEdit", {
      edit: "1",
      text: "# Plan\n\nThe reviewer's edit.\n",
    });

    expect(pendingOf(step.workflow)).toBeNull();
  });

  test("never refuses the reviewer's own pick of the plan (P14)", () => {
    expect(tried(V1, "answerProposal", picking("", { kind: "plan" })).verdict.kind).toBe("allow");
  });
});

describe("an answer reaches Claude once (P6)", () => {
  const MOCKUP: Move = { kind: "mockup", screen: "login" };

  test("the call waiting on the proposal takes it as its result, after its entry", () => {
    const step = tried(
      play(V1, ["propose", proposing("p3", MOCKUP)]),
      "answerProposal",
      picking("p3", MOCKUP),
    );

    expect(step.effects.map(({ kind }) => kind)).toEqual([
      "channel",
      "writeFile",
      "returnToCall",
      "journal",
    ]);
    expect(returned(step)).toEqual([
      { kind: "returnToCall", call: "p3", text: "Accepted: a mockup of: login." },
    ]);
  });

  test("a proposal paused goes as a prompt, its entry alone", () => {
    const paused = play(V1, ["propose", proposing("p3", MOCKUP)], ["pause", { id: "p3" }]);
    const step = tried(paused, "answerProposal", picking("p3", MOCKUP));

    expect(returned(step)).toEqual([]);
    expect(told(step)).toEqual(["Accepted: a mockup of: login."]);
  });

  test("a grill question whose turn was cut reads paused, and the Send's entry is its prompt (A4)", () => {
    const cut = { text: "", reason: "aborted", own: "false", asked: "true" };
    const paused = play(GRILLING, ["askQuestion", ROUND], ["turnAnswered", cut]);

    const sent = tried(paused, "send", {
      parts: "true",
      edit: "",
      names: "held",
      comments: "false",
      text: "",
    });

    expect(paused.regions[0]).toMatchObject({ state: "open", wait: "paused" });
    expect(returned(sent)).toEqual([]);
    expect(sent.workflow.regions[0]).toMatchObject({ wait: null });
  });
});

function refusedIn(w: Workflow): (readonly string[])[] {
  return viewOf(w, TABLE, WORDINGS).refused.map(({ event, effect, reason }) => [
    event,
    effect,
    reason,
  ]);
}

/** The line the region `id` says itself in, as `mcp__vellum__state` prints it. */
function lineOf(w: Workflow, id: string): string | undefined {
  return viewOf(w, TABLE, WORDINGS).regions.find((region) => region.id === id)?.line;
}

/** The events a hold refuses or asks to confirm, as the registry declares them, that a real caller sends. */
function heldBack(): readonly string[] {
  return TABLE.events
    .filter(({ whileHeld }) => whileHeld.effect !== "allow")
    .filter(({ actors }) => actors.some((actor) => actor !== "engine"))
    .map(({ id }) => id);
}

function eachOnce(refused: readonly (readonly string[])[]): boolean {
  return new Set(refused.map(([event]) => event)).size === refused.length;
}

describe("what the page and the band read (§ 5.8)", () => {
  const MOCKUP: Move = { kind: "mockup", screen: "login" };

  const APPROVAL = {
    confirmed: "",
    edit: "",
    text: "",
    notes: "",
    dir: "plans/2026-09-26/the-plan/",
  };

  const sentTwice = (w: Workflow): Workflow => play(w, ["send", COMMENTS], ["send", COMMENTS]);

  test("the pill without a hold keeps today's words, and says plan.md waits only under one (P1)", () => {
    const pills = [
      EMPTY,
      sentTwice(EMPTY),
      V1,
      sentTwice(V1),
      approvalFailed(V1),
      play(V1, ["approve", APPROVAL]),
      play(V1, ["planWritten", PENDING]),
    ].map((w) => pillOf(w));

    expect(pills).toEqual([
      { text: "Drafting", tone: "neutral" },
      { text: "Drafting · 2 sent", tone: "neutral" },
      { text: "In review", tone: "neutral" },
      { text: "In review · 2 sent", tone: "neutral" },
      { text: "Approval failed", tone: "err" },
      { text: "Approved", tone: "ok" },
      { text: "In review", tone: "neutral" },
    ]);
  });

  test("the view carries each region's state, hold, wait and line, never its files", () => {
    const { regions } = viewOf(GRILLING, TABLE, WORDINGS);

    expect(regions.find(({ id }) => id === "grill")).toEqual({
      id: "grill",
      state: "open",
      holds: "grill 1 is open",
      wait: null,
      line: "grill 1: open · holds: grill 1 is open · question: none",
    });
    expect(regions.filter(({ id }) => id !== "grill")).toEqual(
      PARTS.filter(({ id }) => id !== "grill").map(({ id, workflow, walk }) => ({
        id,
        state: "closed",
        line: workflow.line(walk.empty),
      })),
    );
  });

  test("each region says itself as `mcp__vellum__state` prints it: a question paused, a proposal paused", () => {
    const cut = { text: "", reason: "aborted", own: "false", asked: "true" };
    const questionPaused = play(GRILLING, ["askQuestion", ROUND], ["turnAnswered", cut]);
    const proposalPaused = play(V1, ["propose", proposing("p3", MOCKUP)], ["pause", { id: "p3" }]);

    expect(lineOf(questionPaused, "grill")).toBe(
      "grill 1: open · holds: grill 1 is open · question: paused",
    );
    expect(lineOf(proposalPaused, "step")).toBe("step: proposal p3 · wait: paused");
  });

  test("a question Claude waits on, a proposal it waits on, a run asked then running", () => {
    const asked = play(V1, ["requestReview", { version: "1" }]);
    const launched = { seq: "1", agentId: "agent-1", model: "claude-opus-5-5" };

    expect(lineOf(play(GRILLING, ["askQuestion", ROUND]), "grill")).toBe(
      "grill 1: open · holds: grill 1 is open · question: open",
    );
    expect(lineOf(play(V1, ["propose", proposing("p3", MOCKUP)]), "step")).toBe(
      "step: proposal p3 · wait: open",
    );
    expect(lineOf(asked, "review")).toBe("review: plan review 1 of v1 requested");
    expect(lineOf(play(asked, ["reviewLaunched", launched]), "review")).toBe(
      "review: plan review 1 of v1 running",
    );
  });

  test("refused at v1: what Claude would meet, never a run to forget that is not there (F13)", () => {
    expect(refusedIn(V1)).toEqual([["askQuestion", "refuse", "no grill is open"]]);
  });

  test("refused under a grill: each event once, every one a hold holds back, in the words a real caller meets", () => {
    const refused = refusedIn(GRILLING);

    expect(eachOnce(refused)).toBe(true);
    expect(heldBack().filter((event) => !refused.some(([id]) => id === event))).toEqual([]);
    expect(refused).toEqual(
      expect.arrayContaining([
        ["record", "refuse", "grill 1 is open: plan.md waits; you are told when it ends"],
        ["sendEdit", "refuse", "grill 1 is open: the edit waits in the draft until it ends"],
        ["approve", "confirm", "The review is held: grill 1 is open."],
        ["openGrill", "refuse", "grill-1.md is open"],
        ["propose", "refuse", "grill 1 is open: no step is proposed until it ends"],
        ["answerProposal", "refuse", "grill 1 is open"],
        ["requestReview", "refuse", "grill 1 is open"],
      ]),
    );
  });

  test("refused under a plan review: each event once, in the words a real caller meets", () => {
    const running = "plan review 1 of v1 is running";

    const refused = refusedIn(play(V1, ["requestReview", { version: "1" }]));

    expect(eachOnce(refused)).toBe(true);
    expect(heldBack().filter((event) => !refused.some(([id]) => id === event))).toEqual([]);
    expect(refused).toEqual(
      expect.arrayContaining([
        ["record", "refuse", `${running}: plan.md waits; you are told when it ends`],
        ["sendEdit", "refuse", `${running}: the edit waits in the draft until it ends`],
        ["approve", "confirm", `The review is held: ${running}.`],
        ["askQuestion", "refuse", "no grill is open"],
        ["propose", "refuse", `${running}: no step is proposed until it ends`],
        ["answerProposal", "refuse", running],
        ["requestReview", "refuse", "a review of v1 is running"],
      ]),
    );
  });

  test("refused on v2 under a grill: the edit of v2, in the hold's words, not a sample's v1", () => {
    const edited = { edit: "1", text: "# Plan\n\nv2.\n" };
    const v2 = play(V1, ["sendEdit", edited], ["answerProposal", OWN_GRILL]);

    expect(refusedIn(v2).find(([event]) => event === "sendEdit")).toEqual([
      "sendEdit",
      "refuse",
      "grill 1 is open: the edit waits in the draft until it ends",
    ]);
  });

  test("the stage: the pill, then the plan's segment and each extension's, in the registry's order", () => {
    expect(stageOf(GRILLING, WORDINGS)).toEqual({
      workspace: GRILLING.workspace,
      pill: { text: "Held · grill 1 is open", tone: "neutral" },
      segments: ["plan v1 · in review", "grill · open"],
    });
    expect(stageOf(play(V1, ["requestReview", { version: "1" }]), WORDINGS).segments).toEqual([
      "plan v1 · in review",
      "review · running",
    ]);
  });

  test("a grill or a plan review that ended draws no segment", () => {
    const ended = play(GRILLING, ["endGrill", { reason: "stop", at: SAMPLE_AT }]);

    const reviewed = play(
      V1,
      ["requestReview", { version: "1" }],
      ["reviewLaunched", { seq: "1", agentId: "agent-1", model: "claude-opus-5-5" }],
      [
        "reviewDone",
        { seq: "1", outcome: "answer", text: "Fine.", file: "reviews/v1.md", at: SAMPLE_AT },
      ],
    );

    expect(stageOf(ended, WORDINGS).segments).toEqual(["plan v1 · in review"]);
    expect(stageOf(reviewed, WORDINGS).segments).toEqual(["plan v1 · in review"]);
  });

  test("the plan's segment says the draft, the version under review, and the version approved", () => {
    expect(stageOf(EMPTY, WORDINGS).segments).toEqual(["plan draft"]);
    expect(stageOf(V1, WORDINGS).segments).toEqual(["plan v1 · in review"]);
    expect(stageOf(play(V1, ["approve", APPROVAL]), WORDINGS).segments).toEqual([
      "plan v1 · approved",
    ]);
  });
});

describe("the five invariants, on every state the walk reaches (§ 5.10)", () => {
  test("the walk reaches each case the invariants speak of", () => {
    const { reached } = proof();

    expect(Object.entries(reached).filter(([, count]) => count === 0)).toEqual([]);
  });

  for (const name of INVARIANTS) {
    test(name, () => {
      expect(proof().violations[name]).toEqual([]);
    });
  }
});
