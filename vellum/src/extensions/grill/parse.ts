import type { Asked, CloseReason, GrillPosts, Question, Waited } from "./protocol.ts";

/** The boundary of `grill`: what a request carries arrives as `unknown` and is parsed here, once. */

/** No leading zero: `grillFile(grillNumber(name))` must give the name back, or the transcript read is not the one listed. */
const GRILL_FILE = /^grill-([1-9]\d*)\.md$/u;

/** Every break a multiline pattern's `^` matches after: a subject holding one could forge a block of the transcript. */
const LINE_BREAK = /[\n\r\u2028\u2029]/u;

/** What `POST ask` refuses with; the engine reads it to name the way to a grill. */
export const NO_GRILL_OPEN = "no grill is open";

/** `grill-<n>.md`, the one name a grill's transcript has at the root of the plan's directory. */
export function grillFile(n: number): string {
  return `grill-${n}.md`;
}

/** The `n` of `grill-<n>.md`; `null` for any other name. */
export function grillNumber(name: string): number | null {
  const n = GRILL_FILE.exec(name)?.[1];

  return n === undefined ? null : Number(n);
}

/**
 * The file a browser names, down to its last segment: a transcript's name and nothing else, so
 * the route joins it to the plan's directory and no path of the browser's ever reaches the disk.
 */
export function grillFileName(raw: string | null): string | null {
  const name = raw?.split("/").at(-1) ?? "";

  return grillNumber(name) === null ? null : name;
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- the block below IS the boundary parser the rules ask for: it validates the JSON bodies the page and the hooks module post, and there is no earlier place to parse them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A subject, never empty and on one line: the transcript's header writes it as one. */
function subjectText(value: unknown): string | null {
  const subject = text(value);

  return subject === null || LINE_BREAK.test(subject) ? null : subject;
}

/** What `start` takes: the subject of the grill the reviewer opens. */
export function parseSubject(input: unknown): string | null {
  return isRecord(input) ? subjectText(input.subject) : null;
}

export function parseCloseReason(body: unknown): CloseReason | null {
  if (!isRecord(body)) return null;
  const { reason } = body;

  return reason === "page" || reason === "stop" ? reason : null;
}

/** `POST wait`: the transcript a round was asked in, and its first question's number. */
export function parseWait(body: unknown): GrillPosts["wait"] | null {
  return isRecord(body) &&
    typeof body.file === "string" &&
    typeof body.first === "number" &&
    Number.isInteger(body.first) &&
    body.first >= 1
    ? { file: body.file, first: body.first }
    : null;
}

export function parseEvent(body: unknown): GrillPosts["event"] | null {
  const command = isRecord(body) ? text(body.command) : null;

  return command === null ? null : { command };
}

/** An empty text is a turn that ended without one: the transcript says so, so it is kept. */
export function parseAnswer(body: unknown): GrillPosts["answer"] | null {
  return isRecord(body) &&
    typeof body.text === "string" &&
    typeof body.reason === "string" &&
    typeof body.own === "boolean" &&
    typeof body.asked === "boolean"
    ? { text: body.text, reason: body.reason, own: body.own, asked: body.asked }
    : null;
}

/**
 * A title its question's line can hold: the transcript writes it there between `**`, and reads it
 * up to the first `**` after one character at least, so an empty title, a `**` in it or a `*` at
 * its end would cut it where Claude did not.
 */
function titleText(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim() !== "" &&
    !LINE_BREAK.test(value) &&
    !value.includes("**") &&
    !value.endsWith("*")
    ? value
    : null;
}

/** A recommendation, never blank: an answer left out takes it by default, and a blank one names none. */
function parseQuestion(value: unknown): Question | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [raw, ask, rec]: unknown[] = value;
  const title = titleText(raw);

  return title !== null && typeof ask === "string" && typeof rec === "string" && rec.trim() !== ""
    ? { title, ask, rec }
    : null;
}

/**
 * The `q` of a `grill_ask` call and of `POST ask`. `null` unless every question is a
 * `[title, question, recommendation]` triple: a partial round is refused, not half written.
 */
export function parseQuestions(input: unknown): readonly Question[] | null {
  if (!isRecord(input) || !Array.isArray(input.q) || input.q.length === 0) return null;
  const questions = input.q.map((item: unknown) => parseQuestion(item));

  return questions.every((question) => question !== null) ? questions : null;
}

export function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function parseAsked(value: unknown): Asked | null {
  return isRecord(value) &&
    typeof value.first === "number" &&
    typeof value.last === "number" &&
    typeof value.file === "string"
    ? { first: value.first, last: value.last, file: value.file }
    : null;
}

/** What `POST wait` answers; `null` for any other shape. */
export function parseWaited(value: unknown): Waited | null {
  if (!isRecord(value)) return null;

  if (value.kind === "ended" || value.kind === "open") return { kind: value.kind };

  return value.kind === "answered" &&
    typeof value.seq === "number" &&
    typeof value.text === "string"
    ? { kind: "answered", seq: value.seq, text: value.text }
    : null;
}

export function parseError(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string" ? value.error : null;
}

/** Whether `GET state` says a grill is open; `null` for an answer that is no state. */
export function parseIsOpen(value: unknown): boolean | null {
  if (!isRecord(value)) return null;

  return value.kind === "open" || value.kind === "none" ? value.kind === "open" : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */
