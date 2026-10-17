import type { BatchRequest, Outcome, Selection } from "../shared/wire.ts";

/** The overlay's side of its server: the batch it posts, and what became of the batches it sent. */

export type Channel = {
  /** Posts the batch; answers the number the server gave it, or throws why it did not take it. */
  readonly send: (selections: readonly Selection[]) => Promise<number>;
  /** What became of each batch of `seqs`, in their order; `null` when the server does not answer. */
  readonly outcomes: (seqs: readonly number[]) => Promise<Outcome[] | null>;
};

const SEND_TIMEOUT_MS = 10_000;

const ASK_TIMEOUT_MS = 5_000;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- the block below IS the boundary parser of what the server answers. */
function parseSeq(value: unknown): number | null {
  return typeof value === "object" &&
    value !== null &&
    "seq" in value &&
    typeof value.seq === "number"
    ? value.seq
    : null;
}

function parseOutcome(value: unknown): Outcome | null {
  const seq = parseSeq(value);

  if (seq === null || typeof value !== "object" || value === null || !("outcome" in value))
    return null;
  const { outcome } = value;

  if (outcome === "pending" || outcome === "delivered" || outcome === "unknown")
    return { seq, outcome };

  return outcome === "dropped" && "reason" in value && typeof value.reason === "string"
    ? { seq, outcome, reason: value.reason }
    : null;
}

function parseOutcomes(value: unknown): Outcome[] | null {
  if (!Array.isArray(value)) return null;
  const outcomes = value.map((item) => parseOutcome(item));

  return outcomes.every((one) => one !== null) ? outcomes : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

const UNREACHABLE =
  "the pinpoint server does not answer (run /pinpoint:start in Claude Code, then reload the page)";

/** `base` is the server's address for this page, `http://127.0.0.1:<port>/t/<token>/`. */
export function channelOf(base: string): Channel {
  return {
    send: async (selections) => {
      const request: BatchRequest = { selections };

      const response = await fetch(`${base}api/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      }).catch(() => null);

      if (response === null) throw new Error(UNREACHABLE);

      if (!response.ok)
        throw new Error(`the server answered ${response.status}: ${await response.text()}`);
      const seq = parseSeq(await response.json());

      if (seq === null) throw new Error("the server answered without a batch number");

      return seq;
    },
    outcomes: async (seqs) => {
      const query = seqs.map((seq) => `seq=${seq}`).join("&");

      const response = await fetch(`${base}api/outcomes?${query}`, {
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      }).catch(() => null);

      const text = response?.ok === true ? await response.text().catch(() => null) : null;

      if (text === null) return null;
      const outcomes = parseOutcomes(JSON.parse(text));

      if (outcomes === null || outcomes.length !== seqs.length)
        throw new Error(`pinpoint: the server answered what the overlay cannot read: ${text}`);

      return outcomes;
    },
  };
}
