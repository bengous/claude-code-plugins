import type { Journey } from "../model/atlas.ts";
import type { Numbered } from "../model/journeys.ts";
import { formAfter, isEntry, stepsOf } from "../model/journeys.ts";
import type { Tree } from "../model/tree.ts";
import { nodeOf } from "../model/tree.ts";
import { ICONS } from "./panel.ts";
import { esc } from "./svg.ts";

// The ribbon of a journey played, over the foot of the stage (atlas.html's #ribbon): the whole
// journey, a column per section and a cell per step, the data's forms in a row under the cells.
// engine.ts writes it once per journey and sets its marks in place at each step (cellMark,
// covers), so the focus stays where it was. The journey's texts are plain text, shown as written.

/** Steps `first` to `last` of a journey, numbered across its sections. */
export type Span = { readonly first: number; readonly last: number };

/** A stretch of the data row: steps one after another, after each of which the data has `form`. */
export type Run = Span & { readonly form: string };

/** A section's column: its label, its steps numbered across the journey, its data row's runs. */
export type Column = Span & {
  readonly label: string;
  readonly steps: readonly Numbered[];
  readonly runs: readonly Run[];
};

// The data's form after each step (formAfter), steps with the same form one after another in one
// run, a step without a form in none.
function runsOf(journey: Journey, steps: readonly Numbered[]): Run[] {
  const runs: Run[] = [];

  for (const { n } of steps) {
    const form = formAfter(journey, n);
    const before = runs.at(-1);

    if (form === null) {
      continue;
    }

    if (before !== undefined && before.form === form && before.last === n - 1) {
      runs[runs.length - 1] = { ...before, last: n };
    } else {
      runs.push({ form, first: n, last: n });
    }
  }

  return runs;
}

/** A column per section of the journey, in order; a section without a step has none. */
export const columnsOf = (journey: Journey): Column[] =>
  journey.sections.flatMap((section, i) => {
    const steps = stepsOf(journey).filter((at) => at.s === i + 1);
    const first = steps[0];
    const last = steps.at(-1);

    return first === undefined || last === undefined
      ? []
      : [
          {
            label: section.label,
            first: first.n,
            last: last.n,
            steps,
            runs: runsOf(journey, steps),
          },
        ];
  });

const labelOf = (tree: Tree, id: string): string => nodeOf(tree, id).label.replaceAll("\n", " ");

// Its number under the icon of an entry's nature; a stroke at its foot, forward or back, and
// hatched under a condition (atlas.html); its tooltip the step over its ends' labels.
function cell(tree: Tree, { n, step }: Numbered): string {
  const marks = [
    "ribbon-cell",
    ...(step.back === true ? ["back"] : []),
    ...(step.when === undefined ? [] : ["when"]),
  ];

  const title = `${n}. ${labelOf(tree, step.from)} → ${labelOf(tree, step.to)}`;
  const icon = isEntry(step) ? ICONS[step.kind] : "";

  return `<button type="button" class="${marks.join(" ")}" data-step="${n}" title="${esc(title)}"><span class="ribbon-icon">${icon}</span><span>${n}</span></button>`;
}

const span = ({ first, last }: Span): string => `data-first="${first}" data-last="${last}"`;

// A run over the cells of the steps it holds, its whole text as its tooltip.
const run = (column: Column, r: Run): string =>
  `<span class="ribbon-form" ${span(r)} style="grid-column: ${r.first - column.first + 1} / span ${r.last - r.first + 1}" title="${esc(r.form)}">${esc(r.form)}</span>`;

/**
 * The ribbon's steps: a column per section, as wide as its count of steps (`--n`), its label above
 * its cells, cut with its whole text as its tooltip, and its data row under them. A cell carries
 * its step's number (`data-step`), which a click plays; a column and a run, the span of steps
 * they hold (`data-first`, `data-last`).
 */
export const ribbonHtml = (tree: Tree, journey: Journey): string =>
  columnsOf(journey)
    .map((column) =>
      [
        `<div class="ribbon-section" ${span(column)} style="--n: ${column.steps.length}">`,
        `<p class="ribbon-label" title="${esc(column.label)}">${esc(column.label)}</p>`,
        `<div class="ribbon-cells">${column.steps.map((at) => cell(tree, at)).join("")}</div>`,
        `<div class="ribbon-forms">${column.runs.map((r) => run(column, r)).join("")}</div>`,
        `</div>`,
      ].join(""),
    )
    .join("");

/** A cell against the step shown: a step before it, the step itself, or a step to come. */
export type CellMark = "past" | "current" | "next";

export const cellMark = (n: number, shown: number): CellMark =>
  n < shown ? "past" : n === shown ? "current" : "next";

/** Whether a span holds the step shown: its section's column, or the run of the data's form. */
export const covers = ({ first, last }: Span, shown: number): boolean =>
  first <= shown && shown <= last;
