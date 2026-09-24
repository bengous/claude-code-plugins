import type { ProjectPath, Version } from "./paths.ts";
import { PLAN_FILE, versionFile } from "./workspace.ts";

/** What a passage quotes: the text as shown, a whole code block, or a diagram by its source's first line. */
export type PassageKind = "prose" | "code" | "diagram";

/** One place in a document: a quote with its context and source lines. */
export type Passage = {
  readonly kind: PassageKind;
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  /** The lines of the text the passage lives in; for a `removed` one, the version's, never shifted. */
  readonly lines: readonly [number, number];
  /** The quoted lines were removed by the reviewer's edit: the card says so, the feedback too. */
  readonly removed: boolean;
};

/**
 * Where dragged words sit in their element: the characters around them, whitespace collapsed as
 * in the quote, and whether the element holds the same words elsewhere. Empty for a click.
 */
export type WordsContext = {
  readonly prefix: string;
  readonly suffix: string;
  readonly repeated: boolean;
};

/**
 * What an element is, read off the document it sits in, so a reader knows it without opening
 * that document: the nearest heading before it, its ARIA role and accessible name, its opening
 * tag. `""` for what the element has none of.
 */
export type ElementDescription = {
  readonly heading: string;
  readonly role: string;
  readonly name: string;
  readonly openingTag: string;
};

/**
 * One element of a rendered document: where it sits, what it shows, what the page calls it
 * (`label`), and what it is (`description`), which Claude reads.
 */
export type ElementRef = {
  readonly selector: string;
  readonly text: string;
  readonly label: string;
  readonly context: WordsContext;
  readonly description: ElementDescription;
};

/**
 * An element in words: its role and name, the heading it sits under, its opening tag, each part
 * it has. A heading and a name are JSON strings, whose end a quote inside cannot hide.
 */
export function describeElement(description: ElementDescription): string {
  const { heading, role, name, openingTag } = description;

  const named =
    name === "" ? [] : [role === "" ? JSON.stringify(name) : `${role} ${JSON.stringify(name)}`];

  const under = heading === "" ? [] : [`under ${JSON.stringify(heading)}`];
  const phrase = [...named, ...under].join(" ");

  return [phrase, `\`${openingTag}\``].filter((part) => part !== "").join(", ");
}

/** Where a comment points: the document as a whole, passages of it, or elements of it. */
export type Anchor =
  | { readonly kind: "global" }
  | { readonly kind: "text"; readonly passages: readonly [Passage, ...Passage[]] }
  | { readonly kind: "element"; readonly elements: readonly [ElementRef, ...ElementRef[]] };

export type QuickLabel = "clarify" | "verify" | "tooMuch" | "missingCheck";

/** The reviewer's four fixed labels: the name the page shows, the sentence Claude acts on. */
export const QUICK_LABELS = {
  clarify: { name: "Clarify", sentence: "Clarify this: say what it means in concrete terms." },
  verify: {
    name: "Verify",
    sentence: "Verify this against the code or the docs, and cite what you read.",
  },
  tooMuch: {
    name: "Too much",
    sentence: "Overengineered: cut this down to what the request needs.",
  },
  missingCheck: {
    name: "Missing check",
    sentence: "Nothing closes this: add the check that proves it.",
  },
} satisfies Record<QuickLabel, { readonly name: string; readonly sentence: string }>;

export function isQuickLabel(value: string): value is QuickLabel {
  return Object.hasOwn(QUICK_LABELS, value);
}

export const DELETE_SENTENCE = "Delete this.";

/** What the reviewer says about a place: words of their own, "delete this", or a label, a comment by itself. */
export type Mark =
  | { readonly kind: "comment"; readonly body: string }
  | { readonly kind: "delete" }
  | { readonly kind: "label"; readonly label: QuickLabel };

export type Annotation = {
  readonly id: string;
  readonly doc: ProjectPath;
  readonly anchor: Anchor;
  readonly mark: Mark;
};

/** The annotations of `from` named on `to` instead: an edit's text is the next version's file, line for line. */
export function retargetAnnotations(
  annotations: readonly Annotation[],
  from: ProjectPath,
  to: ProjectPath,
): readonly Annotation[] {
  return annotations.map((annotation) =>
    annotation.doc === from ? { ...annotation, doc: to } : annotation,
  );
}

function indent(words: string): string {
  return words.trim().split("\n").join("\n   ");
}

/** The mark in words Claude acts on: a label is its sentence. */
function wordsOf(mark: Mark): string {
  if (mark.kind === "comment") return mark.body;

  return mark.kind === "delete" ? DELETE_SENTENCE : QUICK_LABELS[mark.label].sentence;
}

/**
 * Which round the comments belong to: a version under review, or a batch sent while drafting.
 * `editedFrom` is the version the reviewer edited to make this one, `null` when it is Claude's.
 */
export type FeedbackHeading =
  | { readonly kind: "review"; readonly version: Version; readonly editedFrom: Version | null }
  | { readonly kind: "draft"; readonly batch: number };

/** A removed passage names the version its lines belong to: the one the reviewer edited. */
function linesOf(passage: Passage, heading: FeedbackHeading): string {
  const lines = `lines ${passage.lines[0]}–${passage.lines[1]}`;

  if (!passage.removed) return lines;
  const from = heading.kind === "review" && heading.editedFrom !== null ? heading.editedFrom : null;

  return `${lines}${from === null ? "" : ` of v${from}`} (removed by the reviewer's edit)`;
}

/** Which of the same words a drag took, told only where the element holds them more than once. */
function whichOf(context: WordsContext): string {
  if (!context.repeated) return "";

  return context.prefix === ""
    ? ` (before ${JSON.stringify(context.suffix)})`
    : ` (after ${JSON.stringify(context.prefix)})`;
}

/** Where each anchored place is, one string each; a global anchor has none. */
function placesOf(anchor: Anchor, heading: FeedbackHeading): readonly string[] {
  if (anchor.kind === "global") return [];

  if (anchor.kind === "text") {
    return anchor.passages.map((passage) => `${linesOf(passage, heading)}: "${passage.quote}"`);
  }

  return anchor.elements.map((element) => {
    const { description, text } = element;
    const said = description.name === text ? { ...description, name: "" } : description;
    const quote = text === "" ? "" : `: "${text}"${whichOf(element.context)}`;

    return `element \`${element.selector}\`, ${describeElement(said)}${quote}`;
  });
}

/** The heading, then what Claude must know before the items: the plan on disk is the reviewer's own text. */
function openingOf(heading: FeedbackHeading): readonly string[] {
  if (heading.kind === "draft") return [`# Drafting feedback ${heading.batch}`];
  const title = `# Plan review: changes requested (v${heading.version})`;

  if (heading.editedFrom === null) return [title];
  const { version, editedFrom } = heading;

  return [
    title,
    `The reviewer edited ${PLAN_FILE} directly (v${editedFrom} → v${version}): keep those edits. ${PLAN_FILE} is now v${version}: an item that names \`${versionFile(version)}\` gives ${PLAN_FILE}'s lines.`,
  ];
}

/**
 * What Claude reads before it acts on an approved plan: that the reviewer edited it, then the
 * reviewer's note. `null` when there is neither a note nor an edit to report.
 */
export function formatNotes(
  version: Version,
  editedFrom: Version | null,
  notes: string,
): string | null {
  const edited =
    editedFrom === null
      ? ""
      : `The reviewer edited ${PLAN_FILE} directly (v${editedFrom} → v${version}): read ${PLAN_FILE} again.`;

  const paragraphs = [edited, notes.trim()].filter((paragraph) => paragraph !== "");

  return paragraphs.length === 0
    ? null
    : `${[`# Plan approved: the reviewer's notes (v${version})`, ...paragraphs].join("\n\n")}\n`;
}

/** The text Claude reads: one numbered item per annotation, the place first, the mark in words under it. */
export function formatFeedback(
  annotations: readonly Annotation[],
  heading: FeedbackHeading,
): string {
  const items = annotations.map((annotation, index) => {
    const doc = `\`${annotation.doc}\``;
    const [first, ...rest] = placesOf(annotation.anchor, heading);

    const where =
      first === undefined
        ? `${doc}, general`
        : rest.length === 0
          ? `${doc} ${first}`
          : `${doc}\n${[first, ...rest].map((place) => `   - ${place}`).join("\n")}`;

    return `${index + 1}. ${where}\n   ${indent(wordsOf(annotation.mark))}`;
  });

  return `${[...openingOf(heading), ...items].join("\n\n")}\n`;
}
