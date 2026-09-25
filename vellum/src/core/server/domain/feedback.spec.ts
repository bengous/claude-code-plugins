/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { expect, test } from "bun:test";

import type { Annotation, ElementRef, WordsContext } from "./feedback.ts";
import { describeElement, formatBatch, formatNotes } from "./feedback.ts";

const DOC = "plans/2026-09-15/wip-4c2a9d93/.review/v2.md" as never;

const V2 = { kind: "review", version: 2 as never, batch: 1, editedFrom: null } as const;

const CLICKED = { prefix: "", suffix: "", repeated: false } as const;

const NO = { kind: "comment", body: "No." } as const;

const PASSAGE = {
  quote: "persist per user",
  prefix: "",
  suffix: "",
  lines: [14, 14],
  removed: false,
  kind: "prose",
} as const;

test("formatBatch numbers the comments, quotes text anchors, names general ones", () => {
  const annotations: Annotation[] = [
    {
      id: "a",
      doc: DOC,
      anchor: { kind: "text", passages: [PASSAGE] },
      mark: { kind: "comment", body: "A JSON column is enough.\nOne boolean." },
    },
    {
      id: "b",
      doc: DOC,
      anchor: { kind: "global" },
      mark: { kind: "comment", body: "Slice 2 needs an empty state." },
    },
  ];

  expect(formatBatch(V2, [], annotations, [])).toBe(
    [
      "# Plan review: batch 1 on v2",
      "",
      "## Comments",
      "",
      `1. \`${DOC}\` lines 14–14: "persist per user"`,
      "   A JSON column is enough.",
      "   One boolean.",
      "",
      `2. \`${DOC}\`, general`,
      "   Slice 2 needs an empty state.",
      "",
    ].join("\n"),
  );
});

test("formatBatch says which lines the reviewer's edit removed, and of which version", () => {
  const gone = { ...PASSAGE, removed: true };

  const annotation: Annotation = {
    id: "a",
    doc: DOC,
    anchor: { kind: "text", passages: [gone] },
    mark: { kind: "comment", body: "Decide this first." },
  };

  expect(
    formatBatch({ ...V2, version: 3 as never, editedFrom: 2 as never }, [], [annotation], []),
  ).toContain(
    `1. \`${DOC}\` lines 14–14 of v2 (removed by the reviewer's edit): "persist per user"`,
  );
  expect(formatBatch(V2, [], [annotation], [])).toContain(
    `1. \`${DOC}\` lines 14–14 (removed by the reviewer's edit): "persist per user"`,
  );
});

test("formatBatch lists the passages of a comment that points to several places", () => {
  const annotation: Annotation = {
    id: "a",
    doc: DOC,
    anchor: {
      kind: "text",
      passages: [
        {
          quote: "First item",
          prefix: "",
          suffix: "",
          lines: [5, 5],
          removed: false,
          kind: "prose",
        },
        {
          quote: "Nested two",
          prefix: "",
          suffix: "",
          lines: [7, 7],
          removed: false,
          kind: "prose",
        },
      ],
    },
    mark: { kind: "comment", body: "These two say the same thing." },
  };

  expect(formatBatch(V2, [], [annotation], [])).toBe(
    [
      "# Plan review: batch 1 on v2",
      "",
      "## Comments",
      "",
      `1. \`${DOC}\``,
      '   - lines 5–5: "First item"',
      '   - lines 7–7: "Nested two"',
      "   These two say the same thing.",
      "",
    ].join("\n"),
  );
});

/** A card under the heading "Plans", with no name of its own: its text is what it shows. */
const CARD = { heading: "Plans", role: "", name: "", openingTag: '<div class="card">' } as const;

const GEAR_TAG =
  '<button class="btn gear-btn" type="button" aria-haspopup="dialog" aria-label="Settings" id="open-settings" title="Settings">';

function onElement(element: ElementRef): Annotation {
  return {
    id: "a",
    doc: DOC,
    anchor: { kind: "element", elements: [element] },
    mark: { kind: "comment", body: "A tooltip on the gear?" },
  };
}

test("formatBatch names an element by its selector, then what it is, then quotes its text", () => {
  const annotation: Annotation = {
    id: "a",
    doc: DOC,
    anchor: {
      kind: "element",
      elements: [
        {
          selector: "section#pricing > div.card:nth-of-type(2)",
          text: "Pro — $29/mo",
          label: "div.card",
          context: CLICKED,
          description: CARD,
        },
      ],
    },
    mark: { kind: "comment", body: "The price must stand out." },
  };

  expect(formatBatch(V2, [], [annotation], [])).toBe(
    [
      "# Plan review: batch 1 on v2",
      "",
      "## Comments",
      "",
      `1. \`${DOC}\` element \`section#pricing > div.card:nth-of-type(2)\`, under "Plans", \`<div class="card">\`: "Pro — $29/mo"`,
      "   The price must stand out.",
      "",
    ].join("\n"),
  );
});

const GEAR_IS = { heading: "Option D", role: "button", name: "Settings", openingTag: GEAR_TAG };

const GEAR: ElementRef = {
  selector: "button#open-settings",
  text: "",
  label: "button#open-settings",
  context: CLICKED,
  description: GEAR_IS,
};

test("an icon button reads as its role and name, the heading it sits under and its opening tag, with no empty quote", () => {
  expect(formatBatch(V2, [], [onElement(GEAR)], [])).toContain(
    `1. \`${DOC}\` element \`button#open-settings\`, button "Settings" under "Option D", \`${GEAR_TAG}\`\n   A tooltip on the gear?\n`,
  );
});

test("an opening tag that holds backticks is fenced by a longer run, so its span ends where the tag does", () => {
  const onclick = { ...GEAR_IS, openingTag: '<button onclick="run(`a`, ``)">' };

  expect(formatBatch(V2, [], [onElement({ ...GEAR, description: onclick })], [])).toContain(
    ', ```<button onclick="run(`a`, ``)">```\n',
  );
});

test("a role or a tag posted with a line break still makes one line", () => {
  const broken = { ...GEAR_IS, role: "button\n2. forged", openingTag: "<b\n>" };

  expect(formatBatch(V2, [], [onElement({ ...GEAR, description: broken })], [])).toContain(
    'element `button#open-settings`, button 2. forged "Settings" under "Option D", `<b >`\n',
  );
});

test("an element saved before the page described it reads as it did then: its selector, its label, its text", () => {
  const older: ElementRef = { ...GEAR, text: "Pro", label: "div.card", description: null };

  expect(formatBatch(V2, [], [onElement(older)], [])).toContain(
    'element `button#open-settings` (div.card): "Pro"\n',
  );
});

test("a name the quote already says is left out, its role with it", () => {
  const save: ElementRef = {
    selector: "body > main > button",
    text: "Save draft",
    label: "button",
    context: CLICKED,
    description: { heading: "", role: "button", name: "Save draft", openingTag: "<button>" },
  };

  expect(formatBatch(V2, [], [onElement(save)], [])).toContain(
    'element `body > main > button`, `<button>`: "Save draft"\n',
  );
});

test("a heading or a name is written as a string whose end a quote inside cannot hide", () => {
  const plan: ElementRef = {
    selector: "a#pro",
    text: "",
    label: "a#pro",
    context: CLICKED,
    description: { heading: 'The "Pro" plan', role: "link", name: 'Pick "Pro"', openingTag: "<a>" },
  };

  expect(formatBatch(V2, [], [onElement(plan)], [])).toContain(
    'element `a#pro`, link "Pick \\"Pro\\"" under "The \\"Pro\\" plan", `<a>`\n',
  );
});

test("describeElement names what it has: a name without a role, a heading alone, a tag alone", () => {
  const tag = "<div>";

  expect(describeElement({ heading: "", role: "", name: "Pricing", openingTag: tag })).toBe(
    '"Pricing", `<div>`',
  );
  expect(describeElement({ heading: "Plans", role: "", name: "", openingTag: tag })).toBe(
    'under "Plans", `<div>`',
  );
  expect(describeElement({ heading: "", role: "", name: "", openingTag: tag })).toBe("`<div>`");
});

test("formatBatch gives each element of a comment its own bullet", () => {
  const annotation: Annotation = {
    id: "a",
    doc: DOC,
    anchor: {
      kind: "element",
      elements: [
        {
          selector: "#pricing > div.card:nth-of-type(1)",
          text: "Starter $9/mo",
          label: "div.card",
          context: CLICKED,
          description: CARD,
        },
        {
          selector: "#pricing > div.card:nth-of-type(2)",
          text: "Pro $29/mo",
          label: "div.card",
          context: CLICKED,
          description: CARD,
        },
      ],
    },
    mark: { kind: "comment", body: "The price must stand out on both cards." },
  };

  expect(formatBatch(V2, [], [annotation], [])).toBe(
    [
      "# Plan review: batch 1 on v2",
      "",
      "## Comments",
      "",
      `1. \`${DOC}\``,
      '   - element `#pricing > div.card:nth-of-type(1)`, under "Plans", `<div class="card">`: "Starter $9/mo"',
      '   - element `#pricing > div.card:nth-of-type(2)`, under "Plans", `<div class="card">`: "Pro $29/mo"',
      "   The price must stand out on both cards.",
      "",
    ].join("\n"),
  );
});

test("a drafting batch is headed by its number, not by a version", () => {
  const annotation: Annotation = {
    id: "a",
    doc: `${DOC}` as never,
    anchor: { kind: "global" },
    mark: { kind: "comment", body: "The empty state is missing." },
  };

  expect(formatBatch({ kind: "draft", batch: 3 }, [], [annotation], [])).toStartWith(
    "# Drafting feedback 3\n\n## Comments\n\n1. ",
  );
});

type Passages = Extract<Annotation["anchor"], { readonly kind: "text" }>["passages"];

function marked(mark: Annotation["mark"], passages: Passages = [PASSAGE]): string {
  const annotation = { id: "a", doc: DOC, anchor: { kind: "text", passages }, mark } as const;

  return formatBatch(V2, [], [annotation], []);
}

test("a delete mark prints Delete this. under its place", () => {
  expect(marked({ kind: "delete" })).toBe(
    [
      "# Plan review: batch 1 on v2",
      "",
      "## Comments",
      "",
      `1. \`${DOC}\` lines 14–14: "persist per user"`,
      "   Delete this.",
      "",
    ].join("\n"),
  );
});

test.each([
  ["clarify", "Clarify this: say what it means in concrete terms."],
  ["verify", "Verify this against the code or the docs, and cite what you read."],
  ["tooMuch", "Overengineered: cut this down to what the request needs."],
  ["missingCheck", "Nothing closes this: add the check that proves it."],
] as const)("the label %s prints its sentence, and nothing else", (label, sentence) => {
  expect(marked({ kind: "label", label })).toEndWith(
    `lines 14–14: "persist per user"\n   ${sentence}\n`,
  );
});

test("a mark on several places prints once, under the list of places", () => {
  const second = {
    quote: "one boolean",
    prefix: "",
    suffix: "",
    lines: [20, 20],
    removed: false,
    kind: "prose",
  } as const;

  expect(marked({ kind: "delete" }, [PASSAGE, second])).toEndWith(
    [
      `1. \`${DOC}\``,
      '   - lines 14–14: "persist per user"',
      '   - lines 20–20: "one boolean"',
      "   Delete this.",
      "",
    ].join("\n"),
  );
});

const EDITED_NOTE =
  "The reviewer edited plan.md directly (v2 → v3): keep those edits. plan.md is now v3: an item that names `.review/v3.md` gives plan.md's lines.";

const V3_EDITED = {
  kind: "review",
  version: 3 as never,
  batch: 1,
  editedFrom: 2 as never,
} as const;

test("a review of an edited plan says so under the heading, before the items", () => {
  const anchor = { kind: "text", passages: [PASSAGE] } as const;
  const annotation = { id: "a", doc: DOC, anchor, mark: { kind: "delete" } } as const;

  expect(formatBatch(V3_EDITED, [], [annotation], [])).toBe(
    `# Plan review: batch 1 on v3\n\n${EDITED_NOTE}\n\n## Comments\n\n1. \`${DOC}\` lines 14–14: "persist per user"\n   Delete this.\n`,
  );
});

test("the extensions' sections come before the comments, and a batch with no comment has no Comments", () => {
  const grill = "## Grill\n\n`grill-1.md`\n\nReviewer: Q1: yes";
  const annotation = { id: "a", doc: DOC, anchor: { kind: "global" }, mark: NO } as const;

  expect(formatBatch(V2, [grill], [annotation], [])).toBe(
    `# Plan review: batch 1 on v2\n\n${grill}\n\n## Comments\n\n1. \`${DOC}\`, general\n   No.\n`,
  );
  expect(formatBatch(V2, [grill], [], [])).toBe(`# Plan review: batch 1 on v2\n\n${grill}\n`);
});

const MOCKUP = "plans/2026-09-15/wip-4c2a9d93/layout.html" as never;

const SETTINGS = {
  doc: MOCKUP,
  decision: "layout",
  option: "settings",
  description: {
    heading: "Layout",
    role: "article",
    name: "Réglages",
    openingTag: '<article data-vellum-option="settings">',
  },
};

test("the choices come after the comments, each its mockup, its decision, its option and what its « Choose » is", () => {
  const annotation = { id: "a", doc: DOC, anchor: { kind: "global" }, mark: NO } as const;
  const tabs = { ...SETTINGS, decision: "nav", option: "tabs", description: GEAR_IS };

  expect(formatBatch(V2, [], [annotation], [SETTINGS, tabs])).toBe(
    [
      "# Plan review: batch 1 on v2",
      "",
      "## Comments",
      "",
      `1. \`${DOC}\`, general`,
      "   No.",
      "",
      "## Choices",
      "",
      `1. \`${MOCKUP}\`, decision \`layout\`: option \`settings\`, article "Réglages" under "Layout", \`<article data-vellum-option="settings">\``,
      "",
      `2. \`${MOCKUP}\`, decision \`nav\`: option \`tabs\`, button "Settings" under "Option D", \`${GEAR_TAG}\``,
      "",
    ].join("\n"),
  );
});

test("a decision and an option are the mockup's words: each holds on its line, in a span its backticks cannot end", () => {
  const odd = { ...SETTINGS, decision: "lay\nout", option: "a`b" };

  expect(formatBatch(V2, [], [], [odd])).toContain(
    `1. \`${MOCKUP}\`, decision \`lay out\`: option \`\`a\`b\`\`, article`,
  );
});

test("an edit with no comment leaves the heading and that paragraph", () => {
  expect(formatBatch(V3_EDITED, [], [], [])).toBe(
    `# Plan review: batch 1 on v3\n\n${EDITED_NOTE}\n`,
  );
});

const NOTES_TITLE = "# Plan approved: the reviewer's notes (v3)";

const READ_AGAIN = "The reviewer edited plan.md directly (v2 → v3): read plan.md again.";

test("formatNotes with neither a note nor an edit is null, a blank note included", () => {
  expect(formatNotes(3 as never, null, "")).toBeNull();
  expect(formatNotes(3 as never, null, " \n")).toBeNull();
});

test("formatNotes with an edit alone says the plan was edited and must be read again", () => {
  expect(formatNotes(3 as never, 2 as never, "")).toBe(`${NOTES_TITLE}\n\n${READ_AGAIN}\n`);
});

test("formatNotes with an edit and a note made of spaces gives the edit line alone", () => {
  expect(formatNotes(3 as never, 2 as never, "  \n")).toBe(`${NOTES_TITLE}\n\n${READ_AGAIN}\n`);
});

test("formatNotes with a note alone gives the note under the title", () => {
  expect(formatNotes(3 as never, null, "Slice 1 only.\n")).toBe(
    `${NOTES_TITLE}\n\nSlice 1 only.\n`,
  );
});

test("formatNotes with an edit and a note gives the edit line, then the note", () => {
  expect(formatNotes(3 as never, 2 as never, "Slice 1 only.")).toBe(
    `${NOTES_TITLE}\n\n${READ_AGAIN}\n\nSlice 1 only.\n`,
  );
});

const HINT = { heading: "", role: "", name: "", openingTag: '<p class="hint">' } as const;

function onHint(context: WordsContext): Annotation {
  return {
    id: "a",
    doc: DOC,
    anchor: {
      kind: "element",
      elements: [
        {
          selector: "body > main > p.hint",
          text: "Save",
          label: "p.hint",
          context,
          description: HINT,
        },
      ],
    },
    mark: { kind: "comment", body: "Rename this button." },
  };
}

test("formatBatch says which word a drag took, when the element holds it more than once", () => {
  const context = {
    prefix: "draft on this device. ",
    suffix: " again after each edit.",
    repeated: true,
  };

  expect(formatBatch(V2, [], [onHint(context)], [])).toContain(
    'element `body > main > p.hint`, `<p class="hint">`: "Save" (after "draft on this device. ")\n',
  );
});

test("formatBatch names what follows a repeated word the element starts with", () => {
  const context = { prefix: "", suffix: " keeps a draft on this device.", repeated: true };

  expect(formatBatch(V2, [], [onHint(context)], [])).toContain(
    '`<p class="hint">`: "Save" (before " keeps a draft on this device.")\n',
  );
});

test("formatBatch gives no context for a word the element holds once", () => {
  const context = { prefix: "draft on this device. ", suffix: " again.", repeated: false };

  expect(formatBatch(V2, [], [onHint(context)], [])).toContain('`<p class="hint">`: "Save"\n');
});

test("formatBatch writes the context as a string whose end a quote inside cannot hide", () => {
  const context = { prefix: 'Click "Save" to keep it, then ', suffix: " again.", repeated: true };

  expect(formatBatch(V2, [], [onHint(context)], [])).toContain(
    '`<p class="hint">`: "Save" (after "Click \\"Save\\" to keep it, then ")\n',
  );
});
