import type {
  BatchRequest,
  Box,
  Delivery,
  ElementInfo,
  PageInfo,
  Selection,
  Style,
  Target,
  TargetRequest,
  ZoneImage,
} from "../shared/wire.ts";

/** The ids the server gives the images it keeps, `crypto.randomUUID()`: never a path. */
export const IMAGE_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

/**
 * The server's boundary: a request's body arrives as `unknown` and is parsed here, once, field by
 * field, so nothing unnamed rides along. A body that does not parse whole is refused whole.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns -- the block below IS the boundary parser the rules ask for: it validates what a browser page posts, and there is no earlier place to parse it. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Every item parsed, or `null` when one does not parse: a list is refused whole. */
function listOf<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: T[] = [];

  for (const item of value) {
    const one = parse(item);

    if (one === null) return null;
    parsed.push(one);
  }

  return parsed;
}

function parseBox(value: unknown): Box | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;

  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(width) && isFiniteNumber(height)
    ? { x, y, width, height }
    : null;
}

function parseStyle(value: unknown): Style | null {
  return Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string"
    ? [value[0], value[1]]
    : null;
}

function parseElement(value: unknown): ElementInfo | null {
  if (!isRecord(value)) return null;
  const box = parseBox(value.box);
  const styles = listOf(value.styles, parseStyle);
  const { selector, role, name, heading, openingTag, text } = value;

  return box !== null &&
    styles !== null &&
    typeof selector === "string" &&
    typeof role === "string" &&
    typeof name === "string" &&
    typeof heading === "string" &&
    typeof openingTag === "string" &&
    typeof text === "string"
    ? { selector, role, name, heading, openingTag, text, box, styles }
    : null;
}

function parseTarget(value: unknown): Target | null {
  if (!isRecord(value)) return null;

  if (value.kind === "element") {
    const element = parseElement(value.element);

    return element === null ? null : { kind: "element", element };
  }

  if (value.kind === "zone") {
    const box = parseBox(value.box);
    const elements = listOf(value.elements, parseElement);
    const image = parseZoneImage(value.image);

    return box === null || elements === null || image === null
      ? null
      : { kind: "zone", box, elements, image };
  }

  return null;
}

function parseZoneImage(value: unknown): ZoneImage | null {
  if (!isRecord(value)) return null;
  const { id, failed } = value;

  if (typeof id === "string") return IMAGE_ID.test(id) ? { id } : null;

  return typeof failed === "string" ? { failed } : null;
}

function parsePage(value: unknown): PageInfo | null {
  if (!isRecord(value) || !isRecord(value.viewport) || !isRecord(value.scroll)) return null;
  const { url, title } = value;
  const { width, height } = value.viewport;
  const { x, y } = value.scroll;

  return typeof url === "string" &&
    typeof title === "string" &&
    isFiniteNumber(width) &&
    isFiniteNumber(height) &&
    isFiniteNumber(x) &&
    isFiniteNumber(y)
    ? { url, title, viewport: { width, height }, scroll: { x, y } }
    : null;
}

function parseSelection(value: unknown): Selection | null {
  if (!isRecord(value)) return null;
  const targets = listOf(value.targets, parseTarget);
  const page = parsePage(value.page);
  const { label, note, context } = value;

  return targets !== null &&
    targets.length > 0 &&
    page !== null &&
    (label === null || typeof label === "string") &&
    typeof note === "string" &&
    (context === null || typeof context === "string")
    ? { label, note, targets, page, context }
    : null;
}

export function parseBatchRequest(value: unknown): BatchRequest | null {
  if (!isRecord(value)) return null;
  const selections = listOf(value.selections, parseSelection);

  return selections === null || selections.length === 0 ? null : { selections };
}

export function parseDelivery(value: unknown): Delivery | null {
  if (!isRecord(value) || !isFiniteNumber(value.seq)) return null;
  const { seq, outcome, reason } = value;

  if (outcome === "delivered") return { seq, outcome };

  return outcome === "dropped" && typeof reason === "string" ? { seq, outcome, reason } : null;
}

export function parseTargetRequest(value: unknown): TargetRequest | null {
  return isRecord(value) && typeof value.url === "string" ? { url: value.url } : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns */

const SEQ = /^\d{1,15}$/u;

/** The batch numbers a page asks after, each `seq` of the query; `null` when one is not a number. */
export function parseSeqs(values: readonly string[]): number[] | null {
  return values.every((value) => SEQ.test(value)) ? values.map(Number) : null;
}
