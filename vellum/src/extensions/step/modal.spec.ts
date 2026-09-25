import { describe, expect, test } from "bun:test";

import type { Asking, WindowState } from "./modal.ts";
import { answerFailed, answering, askingOn, dotOf, modalOf, putOff } from "./modal.ts";
import type { Pending, Proposal } from "./protocol.ts";

const PROPOSAL: Proposal = {
  reason: "three choices",
  moves: [{ kind: "grill", subject: "auth", choices: [] }, { kind: "plan" }],
  recommended: 0,
};

const IDEA: Pending = { id: "p1", proposal: PROPOSAL };

const NEXT_IDEA: Pending = { id: "p2", proposal: { ...PROPOSAL, recommended: 1 } };

const PENDING: WindowState = { pending: IDEA, held: null };

const NEXT: WindowState = { pending: NEXT_IDEA, held: null };

/** Nothing waits: none was proposed, or the one shown was answered elsewhere. */
const NONE: WindowState = { pending: null, held: null };

const AUTO: Asking = { kind: "auto" };

const ON_IDEA: Asking = { kind: "asked", on: IDEA };

const BLANK: Asking = { kind: "asked", on: null };

describe("a proposal landing", () => {
  test("on a quiet page opens the modal on it", () => {
    expect(askingOn(PENDING, AUTO, true)).toEqual(ON_IDEA);
    expect(modalOf(PENDING, ON_IDEA, false)).toEqual({ kind: "proposal", pending: IDEA });
  });

  test("on a typing is put off at once, and the modal stays hidden", () => {
    const later = askingOn(PENDING, AUTO, false);

    expect(later).toEqual({ kind: "later", id: "p1" });
    expect(modalOf(PENDING, later, false)).toEqual({ kind: "hidden" });
  });

  test("put off stays hidden once the typing stops; a new one opens", () => {
    const later: Asking = { kind: "later", id: "p1" };

    expect(askingOn(PENDING, later, true)).toEqual(later);
    expect(askingOn(NEXT, later, true)).toEqual({ kind: "asked", on: NEXT_IDEA });
  });
});

describe("a proposal landing while the modal is up", () => {
  test("leaves the blank modal blank, and waits on the dot", () => {
    expect(askingOn(PENDING, BLANK, true)).toEqual(BLANK);
    expect(modalOf(PENDING, BLANK, false)).toEqual({ kind: "blank" });
    expect(dotOf(PENDING, BLANK)).toEqual(IDEA);
  });

  test("leaves the proposal it replaced on screen, and waits on the dot", () => {
    expect(askingOn(NEXT, ON_IDEA, true)).toEqual(ON_IDEA);
    expect(modalOf(NEXT, ON_IDEA, false)).toEqual({ kind: "proposal", pending: IDEA });
    expect(dotOf(NEXT, ON_IDEA)).toEqual(NEXT_IDEA);
  });
});

describe("the modal leaving by itself", () => {
  test("on a proposal answered elsewhere asks nothing more", () => {
    expect(modalOf(NONE, ON_IDEA, false)).toEqual({ kind: "hidden" });
    expect(askingOn(NONE, ON_IDEA, true)).toEqual(AUTO);
  });

  test("on a load that failed is put off, as Esc would: it comes back on the dot, never alone", () => {
    const left = askingOn(null, ON_IDEA, true);

    expect(left).toEqual({ kind: "later", id: "p1" });
    expect(askingOn(PENDING, left, true)).toEqual(left);
    expect(dotOf(PENDING, left)).toEqual(IDEA);
  });
});

describe("Esc, Cancel or the backdrop", () => {
  test("puts off what the slot holds pending, or nothing", () => {
    expect(putOff(NEXT)).toEqual({ kind: "later", id: "p2" });
    expect(putOff(NONE)).toEqual(AUTO);
  });
});

describe("an answer in flight", () => {
  test("draws no modal and no dot; the proposal does not open again", () => {
    const answered = answering(PENDING, "p1");

    expect(modalOf(PENDING, answered, false)).toEqual({ kind: "hidden" });
    expect(dotOf(PENDING, answered)).toBeNull();
    expect(askingOn(PENDING, answered, true)).toEqual(answered);
  });

  test("once refused, puts the proposal back on the dot", () => {
    const refused = answerFailed(answering(PENDING, "p1"), "p1");

    expect(refused).toEqual({ kind: "later", id: "p1" });
    expect(dotOf(PENDING, refused)).toEqual(IDEA);
  });

  test("a proposal that lands meanwhile waits on the dot, never opens", () => {
    expect(askingOn(NEXT, answering(PENDING, "p1"), true)).toEqual({ kind: "later", id: "p2" });
  });

  test("once the slot holds nothing pending, asks nothing more: the next proposal opens", () => {
    expect(askingOn(NONE, answering(PENDING, "p1"), true)).toEqual(AUTO);
  });

  test("on a proposal replaced meanwhile, leaves the new one on the dot, refused or not", () => {
    const answered = answering(NEXT, "p1");

    expect(answered).toEqual({ kind: "later", id: "p2" });
    expect(answerFailed(answered, "p1")).toEqual(answered);
  });
});

describe("the Next step button", () => {
  test("opens the proposal put off, or the modal blank with none", () => {
    expect(modalOf(PENDING, ON_IDEA, false)).toEqual({ kind: "proposal", pending: IDEA });
    expect(modalOf(NONE, BLANK, false)).toEqual({ kind: "blank" });
  });
});

describe("a hold that comes under the modal", () => {
  test("ends the asking: the modal does not come back once the grill that holds is over", () => {
    const held: WindowState = { pending: null, held: "grill 2 is open" };

    expect(askingOn(held, BLANK, true)).toEqual(AUTO);
    expect(modalOf(held, BLANK, false)).toEqual({ kind: "hidden" });
  });
});

describe("an approved page", () => {
  test("shows no modal, whatever the slot holds and whoever asks", () => {
    expect(modalOf(PENDING, ON_IDEA, true)).toEqual({ kind: "hidden" });
    expect(modalOf(NONE, BLANK, true)).toEqual({ kind: "hidden" });
  });
});
