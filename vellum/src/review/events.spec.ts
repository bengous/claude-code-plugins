import { expect, test } from "bun:test";

import { refusedNowWith, rowsACallerMeets, stateWith } from "../proof.ts";
import type { PlanWorkspace } from "../runtime/protocol.ts";
import { parseVersion, parseWipDir } from "../workshop/paths.ts";
import type { RowKey } from "../workshop/rows.ts";
import type {
  EventInput,
  PlanText,
  Region,
  RuleVerdict,
  TablePart,
  Workflow,
} from "../workshop/workflow.ts";
import { next, SAMPLE_AT, tableOf } from "../workshop/workflow.ts";
import { RULES } from "./contract.ts";
import { REVIEW_PART } from "./server.ts";

const TABLE = tableOf([REVIEW_PART]);

const DIR = parseWipDir("plans/2026-09-28/wip-5d2c0b17/");

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

const GRILL_HOLDS: Region = {
  id: "grill",
  state: "open",
  holds: "grill 1 is open",
  wait: null,
  data: {},
};

/** The review in `workspace`, `plan.md` as `planText` says, and a grill holding it or not. */
function review(workspace: PlanWorkspace, planText: PlanText, held = false): Workflow {
  return { workspace, planText, regions: held ? [GRILL_HOLDS] : [] };
}

function judged(w: Workflow, event: string, input: EventInput): RuleVerdict {
  return next(w, TABLE, event, input, "reviewer").verdict;
}

const SEND = { parts: "false", edit: "", names: "held", comments: "true", text: "## Comments\n" };

const APPROVE = {
  confirmed: "",
  edit: "",
  text: "",
  notes: "",
  dir: "plans/2026-09-28/the-plan/",
  noted: "false",
  at: SAMPLE_AT,
};

const STALE: RuleVerdict = {
  kind: "refuse",
  rule: "stale",
  reason: "your edit is of a version no longer under review",
};

/** One test per row of `RULES`, titled by the row: a row without its test does not compile. */
const ROW_TESTS = {
  "record: held": [
    "a version is refused while the review is held: plan.md waits, before any other row",
    () => {
      expect(judged(review(DRAFTING, "absent", true), "record", { unchanged: "keep" })).toEqual({
        kind: "refuse",
        rule: "held",
        reason: "grill 1 is open: plan.md waits; you are told when it ends",
      });
    },
  ],
  "record: no-plan": [
    "a version is refused while plan.md is not there, and recorded once it is",
    () => {
      expect(judged(review(DRAFTING, "absent"), "record", { unchanged: "keep" })).toEqual({
        kind: "refuse",
        rule: "no-plan",
        reason: `write plan.md in ${DIR.value} first`,
      });
      expect(judged(review(DRAFTING, "pending"), "record", { unchanged: "keep" }).kind).toBe(
        "allow",
      );
    },
  ],
  "sendEdit: stale": [
    "an edit of a version no longer under review is refused, before the hold",
    () => {
      expect(
        judged(review(IN_REVIEW, "none", true), "sendEdit", { edit: "2", text: "x\n" }),
      ).toEqual(STALE);
    },
  ],
  "sendEdit: held": [
    "an edit of the version under review waits while the review is held",
    () => {
      expect(
        judged(review(IN_REVIEW, "none", true), "sendEdit", { edit: "1", text: "x\n" }),
      ).toEqual({
        kind: "refuse",
        rule: "held",
        reason: "grill 1 is open: the edit waits in the draft until it ends",
      });
    },
  ],
  "send: changed": [
    "a Send naming what the saved draft no longer holds is refused",
    () => {
      expect(judged(review(IN_REVIEW, "none"), "send", { ...SEND, names: "changed" })).toEqual({
        kind: "refuse",
        rule: "changed",
        reason: "the saved draft no longer holds what you sent, changed in another tab",
      });
    },
  ],
  "send: stale": [
    "a Send carrying an edit of a version no longer under review is refused",
    () => {
      expect(judged(review(IN_REVIEW, "none"), "send", { ...SEND, edit: "2" })).toEqual(STALE);
    },
  ],
  "send: edit": [
    "a Send naming a comment on the plan without the edit it was moved by is refused",
    () => {
      expect(judged(review(IN_REVIEW, "none"), "send", { ...SEND, names: "withoutEdit" })).toEqual({
        kind: "refuse",
        rule: "edit",
        reason: "a comment on the plan goes with your edit",
      });
      expect(judged(review(IN_REVIEW, "none"), "send", SEND).kind).toBe("allow");
    },
  ],
  "approve: held": [
    "an approval asks to confirm while the review is held, and passes once it names that hold",
    () => {
      const w = review(IN_REVIEW, "none", true);

      expect(judged(w, "approve", APPROVE)).toEqual({
        kind: "confirm",
        rule: "held",
        reason: "The review is held: grill 1 is open.",
      });
      expect(judged(w, "approve", { ...APPROVE, confirmed: "grill 1 is open" }).kind).toBe("allow");
    },
  ],
  "approve: no-version": [
    "an approval is refused while drafting",
    () => {
      expect(judged(review(DRAFTING, "pending"), "approve", APPROVE)).toEqual({
        kind: "refuse",
        rule: "no-version",
        reason: "no version is under review yet",
      });
    },
  ],
  "approve: approve-stale": [
    "an approval carrying an edit of another version is refused, naming both",
    () => {
      expect(judged(review(IN_REVIEW, "none"), "approve", { ...APPROVE, edit: "2" })).toEqual({
        kind: "refuse",
        rule: "approve-stale",
        reason: "v1 is under review, not v2",
      });
    },
  ],
  "approve: approve-draft": [
    "an approval is refused while plan.md holds a text the version lacks",
    () => {
      expect(judged(review(IN_REVIEW, "pending"), "approve", APPROVE)).toEqual({
        kind: "refuse",
        rule: "approve-draft",
        reason: "plan.md changed since v1: record it before approving",
      });
    },
  ],
} satisfies { readonly [Row in RowKey<(typeof RULES)[number]>]: readonly [string, () => void] };

for (const [title, run] of Object.values(ROW_TESTS)) test(title, run);

// A row built on a `naming` guard refuses the input, never the state: what is refused now leaves it out.

test("a Send from a tab whose draft changed is refused for that input alone: refusedNow does not list send", () => {
  const w = review(IN_REVIEW, "none");

  expect(judged(w, "send", { ...SEND, names: "changed" }).kind).toBe("refuse");
  expect(refusedNowWith(w, "send", { ...SEND, names: "changed" })).toEqual([]);
});

test("an approval of a stale tab's edit is refused for it alone: mcp__vellum__state does not list approve", () => {
  const w = review(IN_REVIEW, "none");

  expect(judged(w, "approve", { ...APPROVE, edit: "2" }).kind).toBe("refuse");
  expect(stateWith(w, "approve", { ...APPROVE, edit: "2" })).toEqual([]);
});

// A row on the state, of an event a caller sends, is what is refused now: taking it for an input's fails here.

const LISTED = {
  "record: no-plan": [
    "with no plan.md, what is refused now lists record, in the no-plan row's words",
    () => {
      expect(refusedNowWith(review(DRAFTING, "absent"), "record", { unchanged: "keep" })).toEqual([
        {
          event: "record",
          input: { unchanged: "keep" },
          effect: "refuse",
          reason: `write plan.md in ${DIR.value} first`,
        },
      ]);
    },
  ],
  "approve: no-version": [
    "while drafting, what is refused now lists the approval, in the no-version row's words",
    () => {
      expect(refusedNowWith(review(DRAFTING, "pending"), "approve", APPROVE)).toEqual([
        {
          event: "approve",
          input: APPROVE,
          effect: "refuse",
          reason: "no version is under review yet",
        },
      ]);
    },
  ],
  "approve: approve-draft": [
    "while plan.md holds a new text, what is refused now lists the approval, in the approve-draft row's words",
    () => {
      expect(refusedNowWith(review(IN_REVIEW, "pending"), "approve", APPROVE)).toEqual([
        {
          event: "approve",
          input: APPROVE,
          effect: "refuse",
          reason: "plan.md changed since v1: record it before approving",
        },
      ]);
    },
  ],
} satisfies { readonly [row: string]: readonly [string, () => void] };

for (const [title, run] of Object.values(LISTED)) test(title, run);

test("every row of the review's that a caller meets is shown listed in what is refused now", () => {
  expect(Object.keys(LISTED).toSorted()).toEqual(rowsACallerMeets(REVIEW_PART).toSorted());
});

test("a part declaring one of the review's events is refused as the table is built, naming both", () => {
  const record = REVIEW_PART.events.find(({ id }) => id === "record");

  if (record === undefined) throw new Error("the review declares record");
  const clash: TablePart = { events: [{ ...record, owner: "slice" }], rules: [], transitions: {} };

  expect(() => tableOf([REVIEW_PART, clash])).toThrow(
    "record is declared by both review and slice",
  );
});
