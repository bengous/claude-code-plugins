import { expect, test } from "bun:test";

import { parseWipDir } from "../../core/server/domain/paths.ts";
import type { RowKey } from "../../core/server/domain/rows.ts";
import { tablePart } from "../../core/server/domain/rows.ts";
import type { EventInput, Rule, RuleVerdict, Workflow } from "../../core/server/domain/workflow.ts";
import { next, SAMPLE_AT, tableOf } from "../../core/server/domain/workflow.ts";
import { server as step } from "../step/server.ts";
import { RULES } from "./contract.ts";
import { regionOf } from "./grill.ts";
import { server } from "./server.ts";

const PART = tablePart("grill", server.workflow);

const TABLE = tableOf([PART, tablePart("step", step.workflow)]);

const DIR = parseWipDir("plans/2026-09-28/wip-3c9e11d0/");

if (!DIR.ok) throw new Error(DIR.error);

const WORKDIR = DIR.value;

const OPEN = "# Grill: auth\n\n> Session `3c9e11d0` · opened 2026-09-28 10:00\n";

/** The review with grill 1 open or closed, and the step waiting on nothing. */
function review(open: boolean): Workflow {
  return {
    workspace: { kind: "drafting", dir: WORKDIR, batches: 0 },
    planText: "absent",
    regions: [regionOf(open ? { n: 1, doc: OPEN } : null), stepRegionOf()],
  };
}

function stepRegionOf(): Workflow["regions"][number] {
  return { id: "step", state: "closed", data: {} };
}

function judged(w: Workflow, event: string, input: EventInput): RuleVerdict {
  return next(w, TABLE, event, input, "engine").verdict;
}

/** A grill row on the step's `answerProposal`, as the table holds it. */
function heard(id: string): Rule {
  const row = PART.rules.find((one) => one.event === "answerProposal" && one.id === id);

  if (row === undefined) throw new Error(`no row ${id} on answerProposal`);

  return row;
}

const GRILL_MOVE = { move: "grill", subject: "auth" };

/** One test per row of `RULES`, titled by the row: a row without its test does not compile. */
const ROW_TESTS = {
  "openGrill: grill-subject": [
    "openGrill is refused on a subject that is not one line of text, and opens on one",
    () => {
      const refused: RuleVerdict = {
        kind: "refuse",
        rule: "grill-subject",
        reason: "a grill's subject is one line, not empty",
      };

      expect(judged(review(false), "openGrill", { subject: "" })).toEqual(refused);
      expect(judged(review(false), "openGrill", { subject: "a\nb" })).toEqual(refused);
      expect(judged(review(false), "openGrill", { subject: "auth", at: SAMPLE_AT }).kind).toBe(
        "allow",
      );
    },
  ],
  "openGrill: grill-open": [
    "openGrill is refused while a grill is open, naming its transcript",
    () => {
      expect(judged(review(true), "openGrill", { subject: "auth" })).toEqual({
        kind: "refuse",
        rule: "grill-open",
        reason: "grill-1.md is open",
      });
    },
  ],
  "answerProposal: grill-subject": [
    "the step's answer opening a grill on no subject is refused by the grill's row, which the route's parser pre-empts: it is never the verdict",
    () => {
      const row = heard("grill-subject");

      expect([
        row.when(review(false), { move: "grill", subject: "" }),
        row.when(review(false), GRILL_MOVE),
        row.when(review(false), { move: "plan", subject: "" }),
      ]).toEqual([true, false, false]);
    },
  ],
  "answerProposal: grill-open": [
    "the step's answer opening a grill while one is open is refused by the grill's row after the step's hold, which refuses it first",
    () => {
      const row = heard("grill-open");

      expect([
        row.when(review(true), GRILL_MOVE),
        row.when(review(false), GRILL_MOVE),
        row.when(review(true), { move: "plan", subject: "" }),
      ]).toEqual([true, false, false]);
      expect(judged(review(true), "answerProposal", { id: "", ...GRILL_MOVE })).toMatchObject({
        rule: "held",
      });
    },
  ],
  "askQuestion: no-grill": [
    "a round asked with no grill open is refused, no grill is open, and passes while one is",
    () => {
      const q = JSON.stringify([["Style", "bright or plain?", "I recommend bright."]]);

      expect(judged(review(false), "askQuestion", { q })).toEqual({
        kind: "refuse",
        rule: "no-grill",
        reason: "no grill is open",
      });
      expect(judged(review(true), "askQuestion", { q }).kind).toBe("allow");
    },
  ],
} satisfies { readonly [Row in RowKey<(typeof RULES)[number]>]: readonly [string, () => void] };

for (const [title, run] of Object.values(ROW_TESTS)) test(title, run);
