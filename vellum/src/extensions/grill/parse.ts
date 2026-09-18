import type { Asked, CloseReason, Question, ReviewerRound } from "./protocol.ts";

/** What `$.store` keeps under `grill:<session id>`: the reviewer's round the poll already relayed. */
export type RelayedRound = { readonly file: string; readonly round: number };

/** What the poll reads off `GET state`, brands left to the server: the subject and the round to relay. */
export type Relay = {
  readonly subject: string;
  readonly reviewer: (Omit<ReviewerRound, "file"> & { readonly file: string }) | null;
};

/** The boundary of `grill`: what a request carries arrives as `unknown` and is parsed here, once. */

const GRILL_FILE = /^grill-(\d+)\.md$/u;

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

export function parseCloseReason(body: unknown): CloseReason | null {
  if (!isRecord(body)) return null;
  const { reason } = body;

  return reason === "page" || reason === "stop" || reason === "approved" ? reason : null;
}

/** `POST reply`: the reviewer's round, never empty. */
export function parseReply(body: unknown): string | null {
  return isRecord(body) ? text(body.text) : null;
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

/** `GET state` as the poll needs it; `null` when no grill is open. */
export function parseRelay(value: unknown): Relay | null {
  if (!isRecord(value) || value.kind !== "open" || typeof value.subject !== "string") return null;
  const { reviewer, subject } = value;

  return isRecord(reviewer) &&
    typeof reviewer.file === "string" &&
    typeof reviewer.round === "number" &&
    typeof reviewer.text === "string"
    ? { subject, reviewer: { file: reviewer.file, round: reviewer.round, text: reviewer.text } }
    : { subject, reviewer: null };
}

export function parseRelayedRound(value: unknown): RelayedRound | null {
  return isRecord(value) && typeof value.file === "string" && typeof value.round === "number"
    ? { file: value.file, round: value.round }
    : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */
