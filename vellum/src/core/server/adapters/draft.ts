import type {
  Anchor,
  Annotation,
  Choice,
  Choices,
  Draft,
  Edit,
  ElementDescription,
  ElementRef,
  Mark,
  Passage,
  PassageKind,
  Typed,
  WordsContext,
} from "../../protocol.ts";
import { isQuickLabel } from "../domain/feedback.ts";
import { parseProjectPath, parseVersion } from "../domain/paths.ts";

/**
 * The draft's boundary: what `PUT /api/draft` carries and what `.review/draft.json` holds back,
 * one parser for both, so a draft of an older shape is refused whole, never read half-way.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser the rules ask for: it validates the draft the page posts and the file it was saved to, and there is no earlier place to parse them. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAnchor(value: unknown): Anchor | null {
  if (!isRecord(value)) return null;

  if (value.kind === "global") return { kind: "global" };

  if (value.kind === "element") {
    if (!Array.isArray(value.elements)) return null;
    const elements = value.elements.map(parseElementRef);

    if (elements.some((element) => element === null)) return null;
    const [head, ...tail] = elements.filter((element) => element !== null);

    return head === undefined ? null : { kind: "element", elements: [head, ...tail] };
  }

  if (value.kind !== "text" || !Array.isArray(value.passages)) return null;
  const parsed = value.passages.map(parsePassage);

  if (parsed.some((passage) => passage === null)) return null;
  const [first, ...rest] = parsed.filter((passage) => passage !== null);

  return first === undefined ? null : { kind: "text", passages: [first, ...rest] };
}

function parseWordsContext(value: unknown): WordsContext | null {
  if (
    !isRecord(value) ||
    typeof value.prefix !== "string" ||
    typeof value.suffix !== "string" ||
    typeof value.repeated !== "boolean"
  ) {
    return null;
  }

  return { prefix: value.prefix, suffix: value.suffix, repeated: value.repeated };
}

function parseElementDescription(value: unknown): ElementDescription | null {
  if (
    !isRecord(value) ||
    typeof value.heading !== "string" ||
    typeof value.role !== "string" ||
    typeof value.name !== "string" ||
    typeof value.openingTag !== "string"
  ) {
    return null;
  }

  const { heading, role, name, openingTag } = value;

  return { heading, role, name, openingTag };
}

/**
 * A page older than the description sends none, and a draft it saved holds none: that draft keeps
 * the reviewer's unsent comments, so the element is read with no description rather than refused.
 */
function parseOptionalDescription(value: unknown): ElementDescription | null | "unreadable" {
  if (value === undefined || value === null) return null;

  return parseElementDescription(value) ?? "unreadable";
}

function parseElementRef(value: unknown): ElementRef | null {
  const context = isRecord(value) ? parseWordsContext(value.context) : null;
  const description = isRecord(value) ? parseOptionalDescription(value.description) : "unreadable";

  if (
    !isRecord(value) ||
    context === null ||
    description === "unreadable" ||
    typeof value.selector !== "string" ||
    value.selector === "" ||
    typeof value.text !== "string" ||
    typeof value.label !== "string"
  ) {
    return null;
  }

  return { selector: value.selector, text: value.text, label: value.label, context, description };
}

function parsePassageKind(value: unknown): PassageKind | null {
  return value === "prose" || value === "code" || value === "diagram" ? value : null;
}

function parsePassage(value: unknown): Passage | null {
  const kind = isRecord(value) ? parsePassageKind(value.kind) : null;

  if (
    !isRecord(value) ||
    kind === null ||
    typeof value.quote !== "string" ||
    typeof value.prefix !== "string" ||
    typeof value.suffix !== "string" ||
    !Array.isArray(value.lines) ||
    typeof value.lines[0] !== "number" ||
    typeof value.lines[1] !== "number" ||
    typeof value.removed !== "boolean"
  ) {
    return null;
  }

  return {
    kind,
    quote: value.quote,
    prefix: value.prefix,
    suffix: value.suffix,
    lines: [value.lines[0], value.lines[1]],
    removed: value.removed,
  };
}

function parseMark(value: unknown): Mark | null {
  if (!isRecord(value)) return null;

  if (value.kind === "delete") return { kind: "delete" };

  if (value.kind === "label") {
    return typeof value.label === "string" && isQuickLabel(value.label)
      ? { kind: "label", label: value.label }
      : null;
  }

  return value.kind === "comment" && typeof value.body === "string"
    ? { kind: "comment", body: value.body }
    : null;
}

function parseAnnotation(value: unknown): Annotation | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const doc = typeof value.doc === "string" ? parseProjectPath(value.doc) : null;
  const anchor = parseAnchor(value.anchor);
  const mark = parseMark(value.mark);

  if (doc?.ok !== true || anchor === null || mark === null) return null;

  // "Delete this" needs a place to delete: the document as a whole is not one.
  return mark.kind === "delete" && anchor.kind === "global"
    ? null
    : { id: value.id, doc: doc.value, anchor, mark };
}

function parseAnnotations(value: unknown): readonly Annotation[] | null {
  if (!Array.isArray(value)) return null;
  const annotations = value.map((annotation: unknown) => parseAnnotation(annotation));

  return annotations.every((annotation) => annotation !== null) ? annotations : null;
}

/** `null` is a decision without an edit, so a refusal is no `null`: the parsed edit comes wrapped. */
export function parseEdit(value: unknown): { readonly value: Edit | null } | null {
  if (value === null) return { value: null };

  if (!isRecord(value) || typeof value.version !== "number" || typeof value.text !== "string") {
    return null;
  }

  const version = parseVersion(value.version);

  return version.ok ? { value: { version: version.value, text: value.text } } : null;
}

function parseStrings(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) return null;
  const strings: Record<string, string> = {};

  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== "string") return null;
    strings[key] = text;
  }

  return strings;
}

function parseGrillTyped(value: unknown): Typed["grill"] | null {
  if (!isRecord(value)) return null;
  const grill: Record<string, { answers: Readonly<Record<string, string>>; note: string }> = {};

  for (const [path, entry] of Object.entries(value)) {
    const answers = isRecord(entry) ? parseStrings(entry.answers) : null;

    if (answers === null || !isRecord(entry) || typeof entry.note !== "string") return null;
    grill[path] = { answers, note: entry.note };
  }

  return grill;
}

function parseChoice(value: unknown): Choice | null {
  const description = isRecord(value) ? parseElementDescription(value.description) : null;

  return isRecord(value) &&
    description !== null &&
    typeof value.option === "string" &&
    value.option !== ""
    ? { option: value.option, description }
    : null;
}

function parseDecisions(value: unknown): Readonly<Record<string, Choice>> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);

  const decisions = entries.flatMap(([decision, choice]) => {
    const parsed = decision === "" ? null : parseChoice(choice);

    return parsed === null ? [] : [[decision, parsed] as const];
  });

  return decisions.length === entries.length ? Object.fromEntries(decisions) : null;
}

/**
 * A draft saved before the choices holds none: it keeps the reviewer's unsent comments, so it is
 * read with no choice rather than refused.
 */
function parseChoices(value: unknown): Choices | null {
  if (value === undefined) return {};

  if (!isRecord(value) || Array.isArray(value)) return null;
  const entries = Object.entries(value);

  const docs = entries.flatMap(([doc, decisions]) => {
    const parsed = parseProjectPath(doc).ok ? parseDecisions(decisions) : null;

    return parsed === null ? [] : [[doc, parsed] as const];
  });

  return docs.length === entries.length ? Object.fromEntries(docs) : null;
}

function parseTyped(value: unknown): Typed | null {
  if (!isRecord(value) || typeof value.general !== "string") return null;
  const composer = parseStrings(value.composer);
  const grill = parseGrillTyped(value.grill);
  const editor = parseEdit(value.editor);

  return composer === null || grill === null || editor === null
    ? null
    : { general: value.general, composer, grill, editor: editor.value };
}

/**
 * The comments, the edit and the choices a Send takes, plus what is typed. A draft of an older
 * shape is refused whole, written or read back.
 */
export function parseDraft(body: unknown): Draft | null {
  if (!isRecord(body)) return null;
  const annotations = parseAnnotations(body.annotations);
  const edit = parseEdit(body.edit);
  const choices = parseChoices(body.choices);
  const typed = parseTyped(body.typed);

  return annotations === null || edit === null || choices === null || typed === null
    ? null
    : { annotations, edit: edit.value, choices, typed };
}

/** The saved file, read back through the same parser a PUT goes through. */
export function readDraft(saved: string): Draft | null {
  try {
    return parseDraft(JSON.parse(saved));
  } catch {
    return null;
  }
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */
