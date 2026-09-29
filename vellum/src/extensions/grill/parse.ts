import type { Answers } from "../../core/engine/extension.ts";
import type { Bodies } from "../../core/extension.ts";
import type {
  Asked,
  CloseReason,
  GrillPlugs,
  Question,
  QuestionTriple,
  TurnAnswer,
  Waited,
} from "./contract.ts";

/**
 * The boundary of `grill`: what a request carries arrives as `unknown` and is parsed here, once;
 * and the words every runtime of the grill reads, the hooks module and the page included, since
 * `contract.ts` holds the server's values.
 */

/** The tool Claude asks a round with: the hooks half serves it, the server names it to Claude. */
export const ASK_TOOL = "mcp__vellum__grill_ask";

/** A reply's answer that takes the recommendation by choice, where an answer left out takes it by default. */
export const AS_RECOMMENDED = "As recommended.";

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

/** What another slice's `start` hands the grill: the subject it opens on. */
export function parseOpened(input: unknown): GrillPlugs["opened"] | null {
  const subject = parseSubject(input);

  return subject === null ? null : { subject };
}

export function parseCloseReason(body: unknown): CloseReason | null {
  if (!isRecord(body)) return null;
  const { reason } = body;

  return reason === "page" || reason === "stop" ? reason : null;
}

/** `POST close`: who ends the grill. */
function parseClose(body: unknown): { readonly reason: CloseReason } | null {
  const reason = parseCloseReason(body);

  return reason === null ? null : { reason };
}

/** `POST wait`: the transcript a round was asked in, and its first question's number. */
export function parseWait(body: unknown): { readonly file: string; readonly first: number } | null {
  return isRecord(body) &&
    typeof body.file === "string" &&
    typeof body.first === "number" &&
    Number.isInteger(body.first) &&
    body.first >= 1
    ? { file: body.file, first: body.first }
    : null;
}

export function parseEvent(body: unknown): { readonly command: string } | null {
  const command = isRecord(body) ? text(body.command) : null;

  return command === null ? null : { command };
}

/** An empty text is a turn that ended without one: the transcript says so, so it is kept. */
export function parseAnswer(body: unknown): TurnAnswer | null {
  return isRecord(body) &&
    typeof body.text === "string" &&
    typeof body.reason === "string" &&
    typeof body.own === "boolean" &&
    typeof body.asked === "boolean"
    ? { text: body.text, reason: body.reason, own: body.own, asked: body.asked }
    : null;
}

/** `GET blocks`: the transcript's name the page asks for, `null` when it names none; the route answers 404 then. */
function parseBlocksQuery(query: unknown): { readonly file: string | null } {
  return { file: isRecord(query) && typeof query.file === "string" ? query.file : null };
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

/** `POST ask`: the round as triples, each one a question `parseQuestions` takes. */
function parseAsk(body: unknown): { readonly q: readonly QuestionTriple[] } | null {
  const questions = parseQuestions(body);

  return questions === null
    ? null
    : { q: questions.map(({ title, ask, rec }): QuestionTriple => [title, ask, rec]) };
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
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */

/** What each route reads of its request, parsed before the route runs: 400 when it is not one. */
export const BODIES: Bodies<GrillPlugs["server"]> = {
  "GET blocks": parseBlocksQuery,
  "POST close": parseClose,
  "POST ask": parseAsk,
  "POST wait": parseWait,
  "POST event": parseEvent,
  "POST answer": parseAnswer,
};

/** The answer of each route the hooks half posts; `null` for a route that answers nothing. */
export const ANSWERS: Answers<GrillPlugs> = {
  "POST ask": parseAsked,
  "POST wait": parseWaited,
  "POST event": null,
  "POST answer": null,
  "POST close": null,
};
