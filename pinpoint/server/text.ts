import type { Box, ElementInfo, PageInfo, Selection, Target } from "../shared/wire.ts";

/** An app context past this many characters is cut: a saved state can run for megabytes. */
export const CONTEXT_LIMIT = 10_000;

const INDENT = "   ";

function boxText(box: Box): string {
  const { round } = Math;

  return `x ${round(box.x)}, y ${round(box.y)}, ${round(box.width)} × ${round(box.height)}`;
}

function pageText(page: PageInfo): string {
  const title = page.title === "" ? "" : ` · "${page.title}"`;
  const { viewport, scroll } = page;

  return `page: ${page.url}${title} · viewport ${viewport.width} × ${viewport.height} · scroll ${scroll.x}, ${scroll.y}`;
}

function samePage(a: PageInfo, b: PageInfo): boolean {
  return pageText(a) === pageText(b);
}

/** The lines that say what one element is, the first naming its selector after `lead`. */
function elementLines(element: ElementInfo, lead: string): string[] {
  const said = [
    element.role === "" ? "" : `role ${element.role}`,
    element.name === "" ? "" : `name "${element.name}"`,
    element.heading === "" ? "" : `under "${element.heading}"`,
  ].filter((part) => part !== "");

  const text =
    element.text === "" || element.text === element.name ? "" : `text "${element.text}" · `;

  const styles = element.styles.map(([property, value]) => `${property} ${value}`).join("; ");

  return [
    `${lead}${element.selector}`,
    ...(said.length === 0 ? [] : [`  ${said.join(" · ")}`]),
    `  ${element.openingTag}`,
    `  ${text}box ${boxText(element.box)}`,
    ...(styles === "" ? [] : [`  styles: ${styles}`]),
  ];
}

function targetLines(target: Target): string[] {
  if (target.kind === "element") return elementLines(target.element, "element: ");
  const count = target.elements.length;

  return [
    `zone: ${boxText(target.box)}, ${count} element${count === 1 ? "" : "s"} in it`,
    ...target.elements.flatMap((element) =>
      elementLines(element, "- ").map((line, index) => (index === 0 ? `  ${line}` : `    ${line}`)),
    ),
  ];
}

function contextText(context: string): string {
  const points = [...context];

  return points.length <= CONTEXT_LIMIT
    ? context
    : `${points.slice(0, CONTEXT_LIMIT).join("")}… (cut, ${points.length} characters in all)`;
}

function selectionLines(selection: Selection, index: number, previous: Selection | null): string[] {
  const label = selection.label === null ? "" : `[${selection.label}] `;
  const [first = "", ...rest] = selection.note.trim().split("\n");
  const head = `${label}${first}`.trim();

  const { context } = selection;
  const sameContext = previous !== null && previous.context === context;

  const body = [
    ...rest,
    ...(previous !== null && samePage(previous.page, selection.page)
      ? []
      : [pageText(selection.page)]),
    ...selection.targets.flatMap((target) => targetLines(target)),
    ...(context === null || sameContext ? [] : [`app context: ${contextText(context)}`]),
  ];

  return [
    `${index + 1}. ${head === "" ? "(no note)" : head}`,
    ...body.map((line) => `${INDENT}${line}`),
  ];
}

/**
 * The prompt a batch becomes: a header, then each selection, its label and note first, the
 * lines the page reported under it. The page and the app's context repeat only when they changed.
 */
export function batchText(seq: number, selections: readonly Selection[]): string {
  const count = selections.length;

  const header = `pinpoint batch ${seq}: ${count} selection${count === 1 ? "" : "s"} the user made in their running app. Under each label and note, the lines are what the page reported.`;

  const blocks = selections.map((selection, index) =>
    selectionLines(selection, index, index === 0 ? null : (selections[index - 1] ?? null)).join(
      "\n",
    ),
  );

  return [header, ...blocks].join("\n\n");
}
