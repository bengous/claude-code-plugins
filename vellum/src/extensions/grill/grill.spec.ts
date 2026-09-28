import { expect, test } from "bun:test";

import { parseWipDir } from "../../core/server/domain/paths.ts";
import type { RowKey } from "../../core/server/domain/rows.ts";
import { tablePart } from "../../core/server/domain/rows.ts";
import type { EventInput, RuleVerdict, Workflow } from "../../core/server/domain/workflow.ts";
import { next, SAMPLE_AT, tableOf } from "../../core/server/domain/workflow.ts";
import { stateWith } from "../proof.ts";
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

// A row built on a `naming` guard refuses the input, never the state: what is refused now leaves it out.

test("a grill asked on no subject is refused for that input alone: mcp__vellum__state does not list openGrill", () => {
  expect(judged(review(false), "openGrill", { subject: "" })).toMatchObject({
    rule: "grill-subject",
  });
  expect(stateWith(review(false), "openGrill", { subject: "" })).toEqual([]);
});
