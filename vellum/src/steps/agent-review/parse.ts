import type { Bodies } from "../../runtime/extension.ts";
import type {
  Closed,
  Ended,
  Failed,
  Launched,
  Outcome,
  ReviewAsked,
  AgentReviewPlugs,
  Reviews,
  ReviewState,
  Run,
  RunNumber,
  Stopping,
} from "./contract.ts";

/** The boundary of the agent review: what its routes take and answer, and `.review/reviews.json`. */

/** The agent the Review button launches. */
export const REVIEWER = "vellum:plan-reviewer";

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- the block below IS the boundary parser the rules ask for: it validates the JSON bodies the page and the hooks module post, the server's answers the hooks module reads, and `.review/reviews.json`, and there is no earlier place to parse them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A run's number or a version: an integer from 1. */
function counted(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function filled(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseRun(value: unknown): Run | null {
  if (!isRecord(value)) return null;
  const seq = counted(value.seq);
  const version = counted(value.version);

  if (seq === null || version === null) return null;

  if (value.kind === "requested") return { kind: "requested", seq, version };
  const agentId = filled(value.agentId);
  const model = filled(value.model);

  return value.kind === "running" && agentId !== null && model !== null
    ? { kind: "running", seq, version, agentId, model }
    : null;
}

function parseFailed(value: unknown): Failed | null {
  if (!isRecord(value)) return null;
  const seq = counted(value.seq);
  const version = counted(value.version);
  const model = value.model === null ? null : filled(value.model);
  const why = filled(value.why);

  if (value.model !== null && model === null) return null;

  return seq === null || version === null || why === null ? null : { seq, version, model, why };
}

function parseStopping(value: unknown): Stopping[] | null {
  if (!Array.isArray(value)) return null;
  const stopping: Stopping[] = [];

  for (const item of value) {
    const seq = isRecord(item) ? counted(item.seq) : null;
    const agentId = isRecord(item) ? filled(item.agentId) : null;

    if (seq === null || agentId === null) return null;
    stopping.push({ seq, agentId });
  }

  return stopping;
}

/** `GET state`'s answer; `null` for one that is no state. A field it does not read is left behind. */
export function parseReviewState(value: unknown): ReviewState | null {
  if (!isRecord(value)) return null;
  const run = value.run === null ? null : parseRun(value.run);
  const failed = value.failed === null ? null : parseFailed(value.failed);
  const stopping = parseStopping(value.stopping);

  if ((value.run !== null && run === null) || (value.failed !== null && failed === null)) {
    return null;
  }

  return stopping === null ? null : { run, failed, stopping };
}

/** `POST close`'s answer; `null` for one that is not it. */
export function parseClosed(value: unknown): Closed | null {
  const stopping = isRecord(value) ? parseStopping(value.stopping) : null;

  return stopping === null ? null : { stopping };
}

/** `.review/reviews.json`: the state and the last number a run took. */
export function parseReviews(value: unknown): Reviews | null {
  const state = parseReviewState(value);

  if (state === null || !isRecord(value)) return null;
  const { seq } = value;

  return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? { ...state, seq } : null;
}

function parseOutcome(value: unknown): Outcome | null {
  if (!isRecord(value)) return null;

  if (value.kind === "answer") {
    const answer = filled(value.text);

    return answer === null ? null : { kind: "answer", text: answer };
  }

  const why = filled(value.why);

  return value.kind === "failed" && why !== null ? { kind: "failed", why } : null;
}

function seqOf(value: unknown): RunNumber | null {
  const seq = isRecord(value) ? counted(value.seq) : null;

  return seq === null ? null : { seq };
}

function parseAsked(value: unknown): ReviewAsked | null {
  const version = isRecord(value) ? counted(value.version) : null;

  return version === null ? null : { version };
}

function parseLaunched(value: unknown): Launched | null {
  const seq = seqOf(value);
  const agentId = isRecord(value) ? filled(value.agentId) : null;
  const model = isRecord(value) ? filled(value.model) : null;

  return seq === null || agentId === null || model === null ? null : { ...seq, agentId, model };
}

function parseEnded(value: unknown): Ended | null {
  const seq = seqOf(value);
  const outcome = isRecord(value) ? parseOutcome(value.outcome) : null;

  return seq === null || outcome === null ? null : { ...seq, outcome };
}

/** `POST close` takes an empty object. */
function parseNoBody(value: unknown): Readonly<Record<string, never>> | null {
  return isRecord(value) ? {} : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */

/** The body of each route that takes one, parsed before the route runs: 400 when it is not one. */
export const BODIES: Bodies<AgentReviewPlugs["server"]> = {
  "POST request": parseAsked,
  "POST launched": parseLaunched,
  "POST ended": parseEnded,
  "POST forget": seqOf,
  "POST close": parseNoBody,
  "POST stopped": seqOf,
};
