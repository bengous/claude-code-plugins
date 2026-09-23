import type {
  Asked,
  CloseReason,
  Declined,
  GrillPosts,
  Question,
  Relay,
  Suggested,
} from "./protocol.ts";

/**
 * What `$.store` keeps under `grill:<session id>`: the last entry the poll submitted, of which
 * transcript, whether this session's Claude was already pointed at `grilling.md`, and the id of
 * the last decline it relayed.
 */
export type Cursor = {
  readonly file: string;
  readonly seq: number;
  readonly taught: boolean;
  readonly declined: string | null;
};

/**
 * What the poll reads off `GET state`: whether a grill is open, the entries past the cursor, and
 * with none open, the proposal the slot holds declined.
 */
export type Polled =
  | { readonly open: true; readonly relays: readonly Relay[] }
  | { readonly open: false; readonly relays: readonly Relay[]; readonly declined: Declined | null };

/** The boundary of `grill`: what a request carries arrives as `unknown` and is parsed here, once. */

/** No leading zero: `grillFile(grillNumber(name))` must give the name back, or the transcript read is not the one listed. */
const GRILL_FILE = /^grill-([1-9]\d*)\.md$/u;

/** Every break a multiline pattern's `^` matches after: a subject holding one could forge a block of the transcript. */
const LINE_BREAK = /[\n\r\u2028\u2029]/u;

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

/** A subject, never empty and on one line: the transcript's header writes it as one. */
function subjectText(value: unknown): string | null {
  const subject = text(value);

  return subject === null || LINE_BREAK.test(subject) ? null : subject;
}

/** `POST open`: the subject the reviewer typed. */
export function parseSubject(body: unknown): string | null {
  return isRecord(body) ? subjectText(body.subject) : null;
}

/** A `grill_suggest` call and `POST suggest`: a subject and a reason, neither empty. */
export function parseSuggestion(input: unknown): Suggested | null {
  const subject = isRecord(input) ? subjectText(input.subject) : null;
  const reason = isRecord(input) ? text(input.reason) : null;

  return subject === null || reason === null ? null : { subject, reason };
}

/** `POST decline`: the id of the proposal the page showed. */
export function parseDecline(body: unknown): GrillPosts["decline"] | null {
  return isRecord(body) && typeof body.id === "string" && body.id !== "" ? { id: body.id } : null;
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

/** The slot's proposal when the reviewer declined it; a pending one, or none, is `null`. */
function parseDeclined(proposal: unknown): Declined | null {
  if (!isRecord(proposal) || proposal.kind !== "declined" || !isRecord(proposal.declined)) {
    return null;
  }

  const { id, subject } = proposal.declined;

  return typeof id === "string" && typeof subject === "string" ? { id, subject } : null;
}

/** `GET state` as the poll needs it; an entry it cannot read stops the list, so none is skipped. */
export function parsePolled(value: unknown): Polled | null {
  if (!isRecord(value) || !Array.isArray(value.relays)) return null;
  const parsed = value.relays.map((relay: unknown) => parseRelay(relay));
  const unread = parsed.indexOf(null);

  const relays = parsed
    .slice(0, unread === -1 ? parsed.length : unread)
    .filter((relay) => relay !== null);

  return value.kind === "open"
    ? { open: true, relays }
    : { open: false, relays, declined: parseDeclined(value.proposal) };
}

export function parseCursor(value: unknown): Cursor | null {
  return isRecord(value) &&
    typeof value.file === "string" &&
    typeof value.seq === "number" &&
    typeof value.taught === "boolean" &&
    (typeof value.declined === "string" || value.declined === null)
    ? { file: value.file, seq: value.seq, taught: value.taught, declined: value.declined }
    : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */
