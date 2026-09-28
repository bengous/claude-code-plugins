import { expect, test } from "bun:test";

import { refusedNowWith, rowsACallerMeets, stateWith } from "../../proof.ts";
import type { PlanWorkspace } from "../../runtime/protocol.ts";
import { parseVersion, parseWipDir } from "../../workshop/paths.ts";
import type { RowKey } from "../../workshop/rows.ts";
import { tablePart } from "../../workshop/rows.ts";
import type { EventInput, Region, RuleVerdict, Workflow } from "../../workshop/workflow.ts";
import { next, SAMPLE_AT, tableOf } from "../../workshop/workflow.ts";
import { regionOf } from "./agent-review.ts";
import type { Run, Stopping } from "./contract.ts";
import { RULES } from "./contract.ts";
import { server } from "./server.ts";

const PART = tablePart("review", server.workflow);

const TABLE = tableOf([PART]);

const DIR = parseWipDir("plans/2026-09-28/wip-4e1f0a7c/");

if (!DIR.ok) throw new Error(DIR.error);

const V1 = parseVersion(1);

if (!V1.ok) throw new Error(V1.error);

const DRAFTING: PlanWorkspace = { kind: "drafting", dir: DIR.value, batches: 0 };

const IN_REVIEW: PlanWorkspace = {
  kind: "inReview",
  dir: DIR.value,
  version: V1.value,
  batches: 0,
  finalizeError: null,
};

const ASKED: Run = { kind: "requested", seq: 1, version: 1 };

const RUNNING: Run = { kind: "running", seq: 1, version: 1, agentId: "agent-1", model: "opus" };

const GRILL_HOLDS: Region = {
  id: "grill",
  state: "open",
  holds: "grill 1 is open",
  wait: null,
  data: {},
};

/** v1 under review, or none yet, with `run` under way, the agents `stopping`, and a grill holding or not. */
function review(
  workspace: PlanWorkspace,
  run: Run | null,
  stopping: readonly Stopping[] = [],
  held = false,
): Workflow {
  const runs = { seq: run?.seq ?? 0, run, failed: null, stopping };

  return {
    workspace,
    planText: "none",
    regions: [regionOf(runs), ...(held ? [GRILL_HOLDS] : [])],
  };
}

function judged(w: Workflow, event: string, input: EventInput): RuleVerdict {
  return next(w, TABLE, event, input, "engine").verdict;
}

const NO_SUCH_RUN: RuleVerdict = { kind: "refuse", rule: "no-such-run", reason: "no such run" };

const ANSWER = {
  outcome: "answer",
  why: "",
  text: "## Plan review",
  file: "reviews/v1-opus.md",
  at: SAMPLE_AT,
};

const FAILURE = { outcome: "failed", why: "aborted", text: "", file: "" };

/** One test per row of `RULES`, titled by the row: a row without its test does not compile. */
const ROW_TESTS = {
  "requestReview: no-version": [
    "a review is refused while drafting, before any other row",
    () => {
      expect(judged(review(DRAFTING, null, [], true), "requestReview", { version: "1" })).toEqual({
        kind: "refuse",
        rule: "no-version",
        reason: "no version is under review yet",
      });
    },
  ],
  "requestReview: other-version": [
    "a review of another version than the one under review is refused, naming both",
    () => {
      expect(judged(review(IN_REVIEW, null), "requestReview", { version: "2" })).toEqual({
        kind: "refuse",
        rule: "other-version",
        reason: "v1 is under review, not v2",
      });
      expect(judged(review(IN_REVIEW, null), "requestReview", { version: "1" }).kind).toBe("allow");
    },
  ],
  "requestReview: running": [
    "a review is refused while one is under way, asked or running, before the hold",
    () => {
      const refused: RuleVerdict = {
        kind: "refuse",
        rule: "running",
        reason: "a review of v1 is running",
      };

      expect(judged(review(IN_REVIEW, ASKED, [], true), "requestReview", { version: "1" })).toEqual(
        refused,
      );
      expect(judged(review(IN_REVIEW, RUNNING), "requestReview", { version: "1" })).toEqual(
        refused,
      );
    },
  ],
  "requestReview: held": [
    "a review is refused while another step holds the review, the hold its reason",
    () => {
      expect(judged(review(IN_REVIEW, null, [], true), "requestReview", { version: "1" })).toEqual({
        kind: "refuse",
        rule: "held",
        reason: "grill 1 is open",
      });
    },
  ],
  "reviewLaunched: no-such-run": [
    "a launch is refused unless it names the run asked and not yet launched",
    () => {
      const launched = { seq: "1", agentId: "agent-1", model: "opus" };

      expect(judged(review(IN_REVIEW, RUNNING), "reviewLaunched", launched)).toEqual(NO_SUCH_RUN);
      expect(judged(review(IN_REVIEW, ASKED), "reviewLaunched", { ...launched, seq: "2" })).toEqual(
        NO_SUCH_RUN,
      );
      expect(judged(review(IN_REVIEW, ASKED), "reviewLaunched", launched).kind).toBe("allow");
    },
  ],
  "reviewDone: no-such-run": [
    "an end is refused unless it names the run under way",
    () => {
      expect(judged(review(IN_REVIEW, null), "reviewDone", { seq: "1", ...FAILURE })).toEqual(
        NO_SUCH_RUN,
      );
      expect(judged(review(IN_REVIEW, RUNNING), "reviewDone", { seq: "2", ...FAILURE })).toEqual(
        NO_SUCH_RUN,
      );
      expect(judged(review(IN_REVIEW, ASKED), "reviewDone", { seq: "1", ...FAILURE }).kind).toBe(
        "allow",
      );
    },
  ],
  "reviewDone: never-launched": [
    "a verdict for a run asked and never launched is refused; its failure passes",
    () => {
      expect(judged(review(IN_REVIEW, ASKED), "reviewDone", { seq: "1", ...ANSWER })).toEqual({
        kind: "refuse",
        rule: "never-launched",
        reason: "the run was never launched",
      });
      expect(judged(review(IN_REVIEW, RUNNING), "reviewDone", { seq: "1", ...ANSWER }).kind).toBe(
        "allow",
      );
    },
  ],
  "reviewForgotten: no-such-run": [
    "forgetting a run is refused unless it names the run under way",
    () => {
      expect(judged(review(IN_REVIEW, RUNNING), "reviewForgotten", { seq: "2" })).toEqual(
        NO_SUCH_RUN,
      );
      expect(judged(review(IN_REVIEW, RUNNING), "reviewForgotten", { seq: "1" }).kind).toBe(
        "allow",
      );
    },
  ],
  "reviewStopped: no-such-run": [
    "a stop is refused unless it names an agent listed to stop",
    () => {
      const stopping = [{ seq: 1, agentId: "agent-1" }];

      expect(judged(review(IN_REVIEW, null, stopping), "reviewStopped", { seq: "2" })).toEqual(
        NO_SUCH_RUN,
      );
      expect(judged(review(IN_REVIEW, null, stopping), "reviewStopped", { seq: "1" }).kind).toBe(
        "allow",
      );
    },
  ],
} satisfies { readonly [Row in RowKey<(typeof RULES)[number]>]: readonly [string, () => void] };

for (const [title, run] of Object.values(ROW_TESTS)) test(title, run);

// A row built on a `naming` guard refuses the input, never the state: what is refused now leaves it out.

test("a stale tab's review of a version no longer under review is refused for it alone: mcp__vellum__state does not list requestReview", () => {
  expect(judged(review(IN_REVIEW, null), "requestReview", { version: "2" }).kind).toBe("refuse");
  expect(stateWith(review(IN_REVIEW, null), "requestReview", { version: "2" })).toEqual([]);
});

test("a stale tab's ✕ on a run no longer under way is refused for it alone: refusedNow does not list reviewForgotten", () => {
  expect(judged(review(IN_REVIEW, RUNNING), "reviewForgotten", { seq: "2" })).toEqual(NO_SUCH_RUN);
  expect(refusedNowWith(review(IN_REVIEW, RUNNING), "reviewForgotten", { seq: "2" })).toEqual([]);
});

// A row on the state, of an event a caller sends, is what is refused now: taking it for an input's fails here.

const LISTED = {
  "requestReview: no-version": [
    "while drafting, what is refused now lists the review, in the no-version row's words",
    () => {
      expect(refusedNowWith(review(DRAFTING, null), "requestReview", { version: "1" })).toEqual([
        {
          event: "requestReview",
          input: { version: "1" },
          effect: "refuse",
          reason: "no version is under review yet",
        },
      ]);
    },
  ],
  "requestReview: running": [
    "while a run is under way, what is refused now lists the review, in the running row's words",
    () => {
      expect(refusedNowWith(review(IN_REVIEW, ASKED), "requestReview", { version: "1" })).toEqual([
        {
          event: "requestReview",
          input: { version: "1" },
          effect: "refuse",
          reason: "a review of v1 is running",
        },
      ]);
    },
  ],
} satisfies { readonly [row: string]: readonly [string, () => void] };

for (const [title, run] of Object.values(LISTED)) test(title, run);

test("every row of the review's that a caller meets is shown listed in what is refused now", () => {
  expect(Object.keys(LISTED).toSorted()).toEqual(rowsACallerMeets(PART).toSorted());
});
