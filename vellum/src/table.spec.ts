import { expect, test } from "bun:test";

import { parseWipDir } from "./core/server/domain/paths.ts";
import type { EventDecl, Rule, TablePart, Workflow } from "./core/server/domain/workflow.ts";
import { CORE, CORE_PART, HELD, tableOf, verdictOf } from "./core/server/domain/workflow.ts";
import { PARTS as WALKED, proof, whole } from "./extensions/proof.ts";

/**
 * Every row of every event, from every part of the table, as a reader takes it: the core's, then
 * each extension's in the registry's order, rows in the order `verdictOf` judges them. The text is
 * held in `src/__snapshots__/table.spec.ts.snap`, which a PR shows changed when a row does.
 */

const PARTS: readonly { readonly id: string; readonly part: TablePart }[] = [
  { id: CORE, part: CORE_PART },
  ...WALKED.map(({ id, workflow }) => ({ id, part: workflow })),
];

const TABLE = tableOf(WALKED.map(({ workflow }) => workflow));

const DIR = parseWipDir("plans/2026-09-28/wip-7ab1e5e5/");

if (!DIR.ok) throw new Error(DIR.error);

const WORKDIR = DIR.value;

/** A state a walk reached, as the whole table reads it, under this file's directory. */
function here(w: Workflow): Workflow {
  const all = whole(w);

  return all.workspace.kind === "approved"
    ? all
    : { ...all, workspace: { ...all.workspace, dir: WORKDIR } };
}

/** Where a row is looked for, in order: the states the walks reached, in the order they reached them. */
const STATES: readonly Workflow[] = proof().states.map(here);

type Judged = { readonly owner: string; readonly rule: Rule };

function ownerOf(rule: Rule): string {
  return PARTS.find(({ part }) => part.rules.includes(rule))?.id ?? "?";
}

/** The event's rows and its hold's, in the order `verdictOf` judges them. */
function rowsOf(decl: EventDecl): readonly Judged[] {
  const rows = TABLE.rules
    .filter((rule) => rule.event === decl.id)
    .map((rule) => ({ owner: ownerOf(rule), order: rule.order, rule }));

  const { whileHeld } = decl;

  const held =
    whileHeld.effect === "allow"
      ? []
      : [
          {
            owner: decl.owner,
            order: 0,
            rule: heldRule(decl.id, whileHeld.effect, whileHeld.status),
          },
        ];

  return [...rows, ...held].toSorted((a, b) => a.order - b.order);
}

function heldRule(
  event: string,
  effect: "refuse" | "confirm",
  status: 404 | 409 | undefined,
): Rule {
  const rule: Rule = {
    id: HELD,
    event,
    order: 0,
    when: () => true,
    effect,
    refuses: "state",
    reason: () => "",
  };

  return status === undefined ? rule : { ...rule, status };
}

/** The reason as a caller meets it: the verdict of the first sample, on the first state, that this row gives. */
function reasonOf(decl: EventDecl, rule: Rule): string {
  if (rule.id === HELD) {
    return decl.whileHeld.effect === "allow" ? "" : `"${decl.whileHeld.reason("<hold>")}"`;
  }

  for (const w of STATES) {
    for (const input of decl.samples) {
      const verdict = verdictOf(w, TABLE, decl.id, input);

      if (verdict.kind !== "allow" && verdict.rule === rule.id) return `"${verdict.reason}"`;
    }
  }

  return "(the verdict on no sample state)";
}

function sentenceOf(decl: EventDecl, { owner, rule }: Judged, index: number): string {
  const effect = rule.effect === "confirm" ? "asks to confirm" : "refuses";
  const what = rule.refuses === "input" ? `${effect} the input` : effect;
  const status = rule.status === undefined ? "" : ` ${rule.status}`;
  const condition = rule.id === HELD ? "while held" : `when ${rule.condition ?? "(unnamed)"}`;

  return `  ${index + 1}. ${owner}/${rule.id} · ${what}${status} · ${condition} · ${reasonOf(decl, rule)}`;
}

function eventOf(decl: EventDecl): string {
  const passes = decl.whileHeld.effect === "allow" ? " · passes a hold" : "";
  const header = `${decl.id} · owned by ${decl.owner} · sent by ${decl.actors.join(", ")}${passes}`;
  const rows = rowsOf(decl).map((judged, index) => sentenceOf(decl, judged, index));

  return [header, ...(rows.length === 0 ? ["  no row"] : rows)].join("\n");
}

test("every row of every event, from every part, reads as a sentence", () => {
  expect(`\n${TABLE.events.map((decl) => eventOf(decl)).join("\n\n")}\n`).toMatchSnapshot();
});
