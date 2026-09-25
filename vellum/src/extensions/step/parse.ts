import type { Move, Proposal, Proposed, StepAnswer, StepPosts, StepWaited } from "./protocol.ts";

/** The boundary of `step`: what a request carries arrives as `unknown` and is parsed here, once. */

/** Every break a multiline pattern's `^` matches after: a grill's subject holding one could forge a block of its transcript. */
const LINE_BREAK = /[\n\r\u2028\u2029]/u;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- the block below IS the boundary parser the rules ask for: it validates the tool's input and the JSON bodies the page and the hooks module post, and there is no earlier place to parse them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A move's subject, never empty and on one line: a grill's is its transcript's header. */
function lineText(value: unknown): string | null {
  const line = text(value);

  return line === null || LINE_BREAK.test(line) ? null : line;
}

/** A grill's choices, each a title; none given is none, as the reviewer's own grill has. */
function choicesOf(value: unknown): readonly string[] | null {
  if (value === undefined) return [];

  if (!Array.isArray(value)) return null;
  const choices = value.map((choice) => text(choice));

  return choices.every((choice) => choice !== null) ? choices : null;
}

function parseMove(value: unknown): Move | null {
  if (!isRecord(value)) return null;

  if (value.kind === "grill") {
    const subject = lineText(value.subject);
    const choices = choicesOf(value.choices);

    return subject === null || choices === null ? null : { kind: "grill", subject, choices };
  }

  if (value.kind === "mockup") {
    const screen = lineText(value.screen);

    return screen === null ? null : { kind: "mockup", screen };
  }

  if (value.kind === "prototype") {
    const question = lineText(value.question);

    return question === null ? null : { kind: "prototype", question };
  }

  return value.kind === "plan" ? { kind: "plan" } : null;
}

/** A `propose` call and `POST propose`: a reason, one move at least, and the index of one of them. */
export function parseProposal(input: unknown): Proposal | null {
  if (!isRecord(input) || !Array.isArray(input.moves) || input.moves.length === 0) return null;
  const reason = text(input.reason);
  const moves = input.moves.map((move) => parseMove(move));
  const { recommended } = input;

  if (reason === null || !moves.every((move) => move !== null)) return null;

  return typeof recommended === "number" &&
    Number.isInteger(recommended) &&
    recommended >= 0 &&
    recommended < moves.length
    ? { reason, moves, recommended }
    : null;
}

function parseStepAnswer(value: unknown): StepAnswer | null {
  if (!isRecord(value)) return null;

  if (value.kind === "own") {
    const own = text(value.text);

    return own === null ? null : { kind: "own", text: own };
  }

  const move = value.kind === "move" ? parseMove(value.move) : null;

  return move === null ? null : { kind: "move", move };
}

/** `POST answer`: the proposal answered, `null` from the window opened blank, and the answer. */
export function parseAnswer(body: unknown): StepPosts["answer"] | null {
  if (!isRecord(body)) return null;
  const { id } = body;
  const answer = parseStepAnswer(body.answer);

  if (answer === null) return null;

  if (id === null) return { id, answer };

  return typeof id === "string" && id !== "" ? { id, answer } : null;
}

/** `POST wait`: the id `POST propose` answered. */
export function parseWait(body: unknown): StepPosts["wait"] | null {
  return isRecord(body) && typeof body.id === "string" && body.id !== "" ? { id: body.id } : null;
}

export function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function parseProposed(value: unknown): Proposed | null {
  return isRecord(value) && typeof value.id === "string" ? { id: value.id } : null;
}

/** What `POST wait` answers; `null` for any other shape. */
export function parseWaited(value: unknown): StepWaited | null {
  if (!isRecord(value)) return null;

  if (value.kind === "gone" || value.kind === "open") return { kind: value.kind };

  return value.kind === "answered" &&
    typeof value.seq === "number" &&
    typeof value.text === "string"
    ? { kind: "answered", seq: value.seq, text: value.text }
    : null;
}

export function parseError(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string" ? value.error : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */
