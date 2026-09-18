import type { Asked, CloseReason, GrillPosts, Question, Relay, Suggestion } from "./protocol.ts";

/**
 * What `$.store` keeps under `grill:<session id>`: the last entry the poll submitted, of which
 * transcript, and whether this session's Claude was already pointed at `grilling.md`.
 */
export type Cursor = { readonly file: string; readonly seq: number; readonly taught: boolean };

/** What the poll reads off `GET state`: whether a grill is open, and the entries past the cursor. */
export type Polled = { readonly open: boolean; readonly relays: readonly Relay[] };

/** The boundary of `grill`: what a request carries arrives as `unknown` and is parsed here, once. */

/** No leading zero: `grillFile(grillNumber(name))` must give the name back, or the transcript read is not the one listed. */
const GRILL_FILE = /^grill-([1-9]\d*)\.md$/u;

/** What `POST ask` and `POST reply` refuse with; the engine reads it to name the way to a grill. */
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

/** `POST open`: the subject the reviewer typed, never empty. */
export function parseSubject(body: unknown): string | null {
  return isRecord(body) ? text(body.subject) : null;
}

/** A `grill_suggest` call and `POST suggest`: a subject and a reason, neither empty. */
export function parseSuggestion(input: unknown): Suggestion | null {
  const subject = isRecord(input) ? text(input.subject) : null;
  const reason = isRecord(input) ? text(input.reason) : null;

  return subject === null || reason === null ? null : { subject, reason };
}

export function parseCloseReason(body: unknown): CloseReason | null {
  if (!isRecord(body)) return null;
  const { reason } = body;

  return reason === "page" || reason === "stop" ? reason : null;
}

/** `POST reply`: the answers the reviewer typed, by question id, and what they wrote beside them. */
export function parseReply(body: unknown): GrillPosts["reply"] | null {
  if (!isRecord(body) || !Array.isArray(body.answers) || typeof body.note !== "string") return null;

  const answers = body.answers.map((answer: unknown) =>
    isRecord(answer) && typeof answer.id === "string" && typeof answer.text === "string"
      ? { id: answer.id, text: answer.text }
      : null,
  );

  return answers.every((answer) => answer !== null) ? { answers, note: body.note } : null;
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
    typeof body.own === "boolean"
    ? { text: body.text, reason: body.reason, own: body.own }
    : null;
}

function parseQuestion(value: unknown): Question | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [title, ask, rec]: unknown[] = value;

  return typeof title === "string" && typeof ask === "string" && typeof rec === "string"
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
  return isRecord(value) && typeof value.first === "number" && typeof value.last === "number"
    ? { first: value.first, last: value.last }
    : null;
}

export function parseError(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string" ? value.error : null;
}

function parseRelay(value: unknown): Relay | null {
  if (!isRecord(value) || typeof value.seq !== "number") return null;
  const { kind, seq, name, subject } = value;

  if (kind === "reply")
    return typeof value.text === "string" ? { kind, seq, text: value.text } : null;

  if (typeof name !== "string") return null;

  if (kind === "ended") return { kind, seq, name };

  return kind === "opened" && seq === 0 && typeof subject === "string"
    ? { kind, seq, name, subject }
    : null;
}

/** `GET state` as the poll needs it; an entry it cannot read stops the list, so none is skipped. */
export function parsePolled(value: unknown): Polled | null {
  if (!isRecord(value) || !Array.isArray(value.relays)) return null;
  const relays = value.relays.map((relay: unknown) => parseRelay(relay));
  const unread = relays.indexOf(null);

  return {
    open: value.kind === "open",
    relays: relays
      .slice(0, unread === -1 ? relays.length : unread)
      .filter((relay) => relay !== null),
  };
}

export function parseCursor(value: unknown): Cursor | null {
  return isRecord(value) &&
    typeof value.file === "string" &&
    typeof value.seq === "number" &&
    typeof value.taught === "boolean"
    ? { file: value.file, seq: value.seq, taught: value.taught }
    : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */
