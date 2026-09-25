import { describe, expect, test } from "bun:test";

import type { PlanWorkspace } from "../../core/protocol.ts";
import { parseFinalDir, parseVersion, parseWipDir } from "../../core/server/domain/paths.ts";
import { failedText, reviewWhy } from "./labels.ts";

function ok<T>(parsed: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
}

const DIR = ok(parseWipDir("plans/2026-09-25/wip-c95eaf71/"));

const V3 = ok(parseVersion(3));

const DRAFTING: PlanWorkspace = { kind: "drafting", dir: DIR, batches: 0 };

const IN_REVIEW: PlanWorkspace = {
  kind: "inReview",
  dir: DIR,
  version: V3,
  batches: 1,
  finalizeError: null,
};

const APPROVED: PlanWorkspace = {
  kind: "approved",
  dir: ok(parseFinalDir("plans/2026-09-25/review-button/")),
  version: V3,
  notes: false,
};

describe("reviewWhy", () => {
  test("drafting greys the button: no version to review", () => {
    expect(reviewWhy(DRAFTING, null, null)).toEqual({
      kind: "greyed",
      title: "No version under review yet: submit plan.md first",
    });
  });

  test("in review, the button asks for the version under review", () => {
    expect(reviewWhy(IN_REVIEW, null, null)).toEqual({
      kind: "ready",
      version: 3,
      title: "Ask vellum:plan-reviewer to review v3",
    });
  });

  test("a run asked or launched is running, under its number", () => {
    const running = {
      kind: "running" as const,
      title: "A review of v3 is running: its file lands in reviews/",
      seq: 4,
    };

    const held = "plan review 4 of v3 is running";

    expect(reviewWhy(IN_REVIEW, { kind: "requested", seq: 4, version: 3 }, held)).toEqual(running);
    expect(
      reviewWhy(IN_REVIEW, { kind: "running", seq: 4, version: 3, agentId: "a", model: "m" }, held),
    ).toEqual(running);
  });

  test("another's hold greys the button with its reason", () => {
    expect(reviewWhy(IN_REVIEW, null, "grill 1 is open")).toEqual({
      kind: "greyed",
      title: "The review is held: grill 1 is open",
    });
  });

  test("approved draws no button, a run left or not", () => {
    expect(reviewWhy(APPROVED, null, null)).toBeNull();
    expect(reviewWhy(APPROVED, { kind: "requested", seq: 1, version: 3 }, null)).toBeNull();
  });
});

describe("failedText", () => {
  test("names the agent, the version and why, and says nothing was written", () => {
    expect(failedText({ seq: 2, version: 3, model: "m", why: "error" })).toBe(
      "vellum:plan-reviewer ended on v3 without a verdict (error). Nothing was written.",
    );
  });
});
