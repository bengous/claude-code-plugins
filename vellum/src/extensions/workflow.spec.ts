import { describe, expect, test } from "bun:test";

import { parseWipDir } from "../core/server/domain/paths.ts";
import type {
  Effect,
  EventInput,
  Region,
  RuleVerdict,
  Step,
  Table,
  Workflow,
} from "../core/server/domain/workflow.ts";
import {
  held,
  next,
  pillOf,
  planExists,
  refusedNow,
  SAMPLE_AT,
  stageOf,
  tableOf,
  viewOf,
} from "../core/server/domain/workflow.ts";
import { grillFile } from "./grill/parse.ts";
import { nextQuestion, phaseOf, unanswered } from "./grill/transcript.ts";
import { regionOf as grillRegion, roundCall } from "./grill/workflow.ts";
import { parseJson, parseReviews } from "./review/parse.ts";
import { regionOf as reviewRegion } from "./review/workflow.ts";
import { serverExtensions } from "./server.ts";
import type { Move } from "./step/protocol.ts";
import { pendingOf, regionOf as stepRegion } from "./step/workflow.ts";

/** The table as the server assembles it from the registry: the core's, then each extension's in order. */
const TABLE: Table = tableOf(
  serverExtensions.flatMap(({ workflow }) => (workflow === undefined ? [] : [workflow])),
);

const DIR = parseWipDir("plans/2026-09-26/wip-4c2a9d93/");

if (!DIR.ok) throw new Error(DIR.error);

const EMPTY: Workflow = {
  workspace: { kind: "drafting", dir: DIR.value, batches: 0 },
  planText: "absent",
  regions: [grillRegion(null), stepRegion(null), reviewRegion(null)],
};

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

/** The texts a step tells Claude through the channel, in order. */
function told(step: Step): string[] {
  return step.effects.flatMap((effect) =>
    effect.kind === "channel" && effect.entry.kind === "text" ? [effect.entry.text] : [],
  );
}

/** The review as a rename that failed leaves it: the version under review, the error in memory. */
function approvalFailed(w: Workflow): Workflow {
  const { workspace } = w;

  if (workspace.kind !== "inReview") throw new Error("no version is under review");

  return { ...w, workspace: { ...workspace, finalizeError: "rename refused" } };
}

function returned(step: Step): Extract<Effect, { kind: "returnToCall" }>[] {
  return step.effects.flatMap((effect) => (effect.kind === "returnToCall" ? [effect] : []));
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

    expect(step.workflow.regions.map(({ state }) => state)).toEqual(["closed", "closed", "closed"]);
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

describe("what the page and the band read (§ 5.8)", () => {
  const SEGMENTS = serverExtensions.flatMap(({ id, workflow }) =>
    workflow === undefined ? [] : [{ id, segment: workflow.segment }],
  );

  const refusedIn = (w: Workflow): (readonly string[])[] =>
    viewOf(w, TABLE).refused.map(({ event, effect, reason }) => [event, effect, reason]);

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

  test("the view carries each region's state, hold and wait, never its files", () => {
    expect(viewOf(GRILLING, TABLE).regions).toEqual([
      { id: "grill", state: "open", holds: "grill 1 is open", wait: null },
      { id: "step", state: "closed" },
      { id: "review", state: "closed" },
    ]);
  });

  test("refused at v1: what Claude would meet, never a run to forget that is not there (F13)", () => {
    expect(refusedIn(V1)).toEqual([["askQuestion", "refuse", "no grill is open"]]);
  });

  test("refused under a grill: each event once, in the words a real caller meets", () => {
    expect(refusedIn(GRILLING)).toEqual([
      ["record", "refuse", "grill 1 is open: plan.md waits; you are told when it ends"],
      ["sendEdit", "refuse", "grill 1 is open: the edit waits in the draft until it ends"],
      ["approve", "confirm", "The review is held: grill 1 is open."],
      ["openGrill", "refuse", "grill-1.md is open"],
      ["propose", "refuse", "grill 1 is open: no step is proposed until it ends"],
      ["answerProposal", "refuse", "grill 1 is open"],
      ["requestReview", "refuse", "grill 1 is open"],
    ]);
  });

  test("refused under a plan review: each event once, in the words a real caller meets", () => {
    const running = "plan review 1 of v1 is running";

    expect(refusedIn(play(V1, ["requestReview", { version: "1" }]))).toEqual([
      ["record", "refuse", `${running}: plan.md waits; you are told when it ends`],
      ["sendEdit", "refuse", `${running}: the edit waits in the draft until it ends`],
      ["approve", "confirm", `The review is held: ${running}.`],
      ["askQuestion", "refuse", "no grill is open"],
      ["propose", "refuse", `${running}: no step is proposed until it ends`],
      ["answerProposal", "refuse", running],
      ["requestReview", "refuse", "a review of v1 is running"],
    ]);
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
    expect(stageOf(GRILLING, SEGMENTS)).toEqual({
      workspace: GRILLING.workspace,
      pill: { text: "Held · grill 1 is open", tone: "neutral" },
      segments: ["plan v1 · in review", "grill · open"],
    });
    expect(stageOf(play(V1, ["requestReview", { version: "1" }]), SEGMENTS).segments).toEqual([
      "plan v1 · in review",
      "review · running",
    ]);
  });

  test("the plan's segment says the draft, the version under review, and the version approved", () => {
    expect(stageOf(EMPTY, SEGMENTS).segments).toEqual(["plan draft"]);
    expect(stageOf(V1, SEGMENTS).segments).toEqual(["plan v1 · in review"]);
    expect(stageOf(play(V1, ["approve", APPROVAL]), SEGMENTS).segments).toEqual([
      "plan v1 · approved",
    ]);
  });
});

/**
 * A state as the invariants tell it apart: the workspace, `plan.md`, and each region by what it
 * holds and waits on, a transcript by its phase and the questions waiting, a proposal by its id and
 * moves, the runs by their kinds. Counters the invariants never read (a grill's number, a run's,
 * the Sends on a version) are left out, so the walk ends. Cached by identity: a step leaves every
 * region it does not touch as it was.
 */
const keys = new WeakMap<Workflow | Region, string>();

function cached(of: Workflow | Region, make: () => string): string {
  const known = keys.get(of);

  if (known !== undefined) return known;
  const made = make();
  keys.set(of, made);

  return made;
}

function regionKey(region: Region): string {
  return cached(region, () => {
    const { id, state, data } = region;
    const open = region.state === "open" ? [region.holds !== null, region.wait] : [];

    if (id === "grill") {
      const doc = String(data.doc ?? "");

      return JSON.stringify([id, state, ...open, phaseOf(doc), unanswered(doc).length]);
    }

    if (id === "step") {
      const moves = pendingOf({ ...EMPTY, regions: [region] })?.proposal.moves.map(
        ({ kind }) => kind,
      );

      return JSON.stringify([id, state, ...open, data.pending, moves]);
    }

    const reviews = parseReviews(parseJson(String(data.reviews)));
    const run = reviews?.run ?? null;

    return JSON.stringify([
      id,
      state,
      run?.kind,
      run?.version,
      reviews?.failed !== null,
      reviews?.stopping.length,
    ]);
  });
}

function keyOf(w: Workflow): string {
  return cached(w, () => {
    const { workspace } = w;
    const version = workspace.kind === "drafting" ? 0 : workspace.version;
    const sent = workspace.kind !== "approved" && workspace.batches > 0;

    return JSON.stringify([workspace.kind, version, sent, w.planText, ...w.regions.map(regionKey)]);
  });
}

/** At most 3 versions (§ 5.10), two questions a grill and two agents to stop, so the walk ends. */
function bounded(w: Workflow): boolean {
  const { workspace } = w;
  const [grill, , review] = w.regions;
  const stopping = parseReviews(parseJson(String(review?.data.reviews)))?.stopping.length ?? 0;

  return (
    (workspace.kind === "drafting" || workspace.version <= 3) &&
    nextQuestion(String(grill?.data.doc ?? "")) <= 3 &&
    stopping <= 2
  );
}

type Violations = Readonly<Record<string, string[]>>;

type Walk = {
  readonly states: number;
  readonly steps: number;
  readonly violations: Violations;
  readonly reached: Readonly<Record<string, number>>;
};

const INVARIANTS = [
  "heldDraftIsShown",
  "noPlanStepOverAPlan",
  "approvalClosesEverything",
  "noticeOnceTheLastHoldFalls",
  "answerReachesClaudeOnce",
] as const;

function stateBroken(w: Workflow): (typeof INVARIANTS)[number][] {
  const hold = held(w);
  const pending = pendingOf(w);

  return [
    ...(hold !== null &&
    w.planText === "pending" &&
    pillOf(w).text !== `Held · ${hold} · plan.md waits`
      ? ["heldDraftIsShown" as const]
      : []),
    ...(planExists(w) && pending?.proposal.moves.some(({ kind }) => kind === "plan") === true
      ? ["noPlanStepOverAPlan" as const]
      : []),
    ...(w.workspace.kind === "approved" && w.regions.some(({ state }) => state !== "closed")
      ? ["approvalClosesEverything" as const]
      : []),
  ];
}

/** The call a region's open wait is, `null` with none: a proposal's id, or the open transcript. */
function callOf(
  w: Workflow,
  id: "grill" | "step",
): { readonly call: string; readonly wait: "open" | "paused" } | null {
  const region = w.regions.find((one) => one.id === id);

  if (region?.state !== "open" || region.wait === null) return null;

  const call =
    id === "step"
      ? String(region.data.pending)
      : roundCall(grillFile(Number(region.data.n)), String(region.data.doc));

  return { call, wait: region.wait };
}

function stepBroken(
  from: Workflow,
  event: string,
  input: EventInput,
  step: Step,
): (typeof INVARIANTS)[number][] {
  const lifted =
    held(from) !== null && held(step.workflow) === null && step.workflow.planText === "pending";

  const notices = told(step).filter((text) => text.startsWith("plan.md changed while")).length;
  const calls = returned(step).map(({ call }) => call);
  const channel = step.effects.findIndex(({ kind }) => kind === "channel");
  const firstCall = step.effects.findIndex(({ kind }) => kind === "returnToCall");
  const answered = step.verdict.kind === "allow" ? answeredWait(from, event, input) : null;

  const once =
    new Set(calls).size === calls.length &&
    (firstCall === -1 || (channel !== -1 && channel < firstCall)) &&
    (answered === null
      ? calls.length === 0
      : answered.wait === "open"
        ? calls.length === 1 && calls[0] === answered.call && channel !== -1
        : calls.length === 0 && channel !== -1);

  return [
    ...(notices === (lifted ? 1 : 0) ? [] : ["noticeOnceTheLastHoldFalls" as const]),
    ...(once ? [] : ["answerReachesClaudeOnce" as const]),
  ];
}

/** The wait an allowed event answers: the proposal a pick settles, or the grill's questions a Send with its part closes. */
function answeredWait(from: Workflow, event: string, input: EventInput): ReturnType<typeof callOf> {
  if (event === "answerProposal") return callOf(from, "step");

  return event === "send" && input.parts === "true" ? callOf(from, "grill") : null;
}

let walked: Walk | null = null;

/** Breadth first from the empty workflow, every event with every sample, and a confirmation asked, confirmed. */
function walk(): Walk {
  if (walked !== null) return walked;
  const seen = new Set([keyOf(EMPTY)]);
  const queue = [EMPTY];

  const violations: Record<string, string[]> = Object.fromEntries(
    INVARIANTS.map((name) => [name, []]),
  );

  const reached = {
    heldDraft: 0,
    approvedOverOpen: 0,
    returned: 0,
    prompted: 0,
    notices: 0,
    pausedQuestions: 0,
    planGoneInReview: 0,
  };

  let steps = 0;

  const broke = (names: readonly string[], what: string): void => {
    for (const name of names) if ((violations[name]?.length ?? 0) < 3) violations[name]?.push(what);
  };

  for (let at = 0; at < queue.length; at += 1) {
    const from = queue[at] ?? EMPTY;

    broke(stateBroken(from), keyOf(from));

    if (held(from) !== null && from.planText === "pending") reached.heldDraft += 1;

    if (from.workspace.kind === "inReview" && from.planText === "absent")
      reached.planGoneInReview += 1;

    if (from.regions[0]?.state === "open" && from.regions[0].wait === "paused")
      reached.pausedQuestions += 1;

    for (const decl of TABLE.events) {
      for (const sample of decl.samples) {
        const first = tried(from, decl.id, sample);

        const confirmed =
          first.verdict.kind === "confirm" ? [{ ...sample, confirmed: held(from) ?? "" }] : [];

        for (const input of [sample, ...confirmed]) {
          const step = input === sample ? first : tried(from, decl.id, input);
          steps += 1;
          broke(
            stepBroken(from, decl.id, input, step),
            `${decl.id} ${JSON.stringify(input)} from ${keyOf(from)}`,
          );
          reached.returned += returned(step).length;
          reached.notices += told(step).filter((text) =>
            text.startsWith("plan.md changed while"),
          ).length;

          if (
            step.verdict.kind === "allow" &&
            answeredWait(from, decl.id, input)?.wait === "paused"
          )
            reached.prompted += 1;

          if (
            step.workflow.workspace.kind === "approved" &&
            from.workspace.kind !== "approved" &&
            from.regions.some(({ state }) => state === "open")
          )
            reached.approvedOverOpen += 1;
          const key = keyOf(step.workflow);

          if (!bounded(step.workflow) || seen.has(key)) continue;
          seen.add(key);
          queue.push(step.workflow);
        }
      }
    }
  }

  walked = { states: queue.length, steps, violations, reached };

  return walked;
}

describe("the five invariants, on every state the walk reaches (§ 5.10)", () => {
  test("the walk reaches each case the invariants speak of", () => {
    const { reached } = walk();

    expect(Object.entries(reached).filter(([, count]) => count === 0)).toEqual([]);
  });

  for (const name of INVARIANTS) {
    test(name, () => {
      expect(walk().violations[name]).toEqual([]);
    });
  }
});
