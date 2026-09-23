import { describe, expect, test } from "bun:test";

import type { ProjectPath } from "../../core/server/domain/paths.ts";
import type { Asking } from "./modal.ts";
import { askingOn, modalOf } from "./modal.ts";
import type { GrillState, Suggestion } from "./protocol.ts";

const IDEA: Suggestion = { id: "p1", subject: "auth", reason: "three choices" };

const PENDING: GrillState = {
  kind: "none",
  proposal: { kind: "pending", suggestion: IDEA },
  relays: [],
};

const NONE: GrillState = { kind: "none", proposal: null, relays: [] };

const AUTO: Asking = { kind: "auto" };

const ASKED: Asking = { kind: "asked" };

describe("a proposal landing", () => {
  test("on a quiet page opens the modal on it", () => {
    expect(askingOn(PENDING, AUTO, true)).toEqual(AUTO);
    expect(modalOf(PENDING, AUTO, false, true)).toEqual({ kind: "proposal", suggestion: IDEA });
  });

  test("on a typing is put off at once, and the modal stays hidden", () => {
    expect(modalOf(PENDING, AUTO, false, false)).toEqual({ kind: "hidden" });
    expect(askingOn(PENDING, AUTO, false)).toEqual({ kind: "later", id: "p1" });
  });

  test("put off stays hidden once the typing stops; a new one opens", () => {
    const later: Asking = { kind: "later", id: "p1" };

    const next: GrillState = {
      ...NONE,
      proposal: { kind: "pending", suggestion: { ...IDEA, id: "p2" } },
    };

    expect(modalOf(PENDING, later, false, true)).toEqual({ kind: "hidden" });
    expect(modalOf(next, later, false, true)).toMatchObject({ kind: "proposal" });
  });
});

describe("the Grill button", () => {
  test("opens the proposal put off, or the modal blank with none", () => {
    expect(modalOf(PENDING, ASKED, false, true)).toEqual({ kind: "proposal", suggestion: IDEA });
    expect(modalOf(NONE, ASKED, false, true)).toEqual({ kind: "blank" });
  });
});

describe("a grill that opens under the modal the Grill button asked for", () => {
  test("ends the asking: the modal does not come back once that grill is over", () => {
    const open: GrillState = {
      kind: "open",
      // SAFETY: a literal path for a fixture; the brand is the parser's to grant, and nothing here parses.
      file: "plans/2026-09-23/wip-c95eaf71/grill-2.md" as ProjectPath,
      subject: "auth",
      phase: "working",
      relays: [],
    };

    expect(askingOn(open, ASKED, true)).toEqual(AUTO);
  });
});

describe("an approved page", () => {
  test("shows no modal, whatever the slot holds and whoever asks", () => {
    expect(modalOf(PENDING, AUTO, true, true)).toEqual({ kind: "hidden" });
    expect(modalOf(NONE, ASKED, true, true)).toEqual({ kind: "hidden" });
  });
});

describe("a declined proposal", () => {
  test("opens nothing", () => {
    const declined: GrillState = {
      ...NONE,
      proposal: { kind: "declined", declined: { id: "p1", subject: "auth" } },
    };

    expect(modalOf(declined, AUTO, false, true)).toEqual({ kind: "hidden" });
  });
});
