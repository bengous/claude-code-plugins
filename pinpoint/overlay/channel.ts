import type { BatchRequest, PageEvent, Selection } from "../shared/wire.ts";

/** The overlay's side of its server: the batch it posts, and the events the server streams back. */

export type Listener = {
  readonly event: (event: PageEvent) => void;
  readonly connected: (up: boolean) => void;
};

export type Channel = {
  /** Posts the batch; answers the number the server gave it, or throws why it did not take it. */
  readonly send: (selections: readonly Selection[]) => Promise<number>;
};

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- the block below IS the boundary parser of what the server answers and streams. */
function parseSeq(value: unknown): number | null {
  return typeof value === "object" &&
    value !== null &&
    "seq" in value &&
    typeof value.seq === "number"
    ? value.seq
    : null;
}

function parseEvent(value: unknown): PageEvent | null {
  const seq = parseSeq(value);

  if (seq === null || typeof value !== "object" || value === null || !("type" in value))
    return null;

  if (value.type === "delivered") return { type: "delivered", seq };

  return value.type === "dropped" && "reason" in value && typeof value.reason === "string"
    ? { type: "dropped", seq, reason: value.reason }
    : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

const UNREACHABLE =
  "the pinpoint server does not answer (run /pinpoint:start in Claude Code, then reload the page)";

/** `base` is the server's address for this page, `http://127.0.0.1:<port>/t/<token>/`. */
export function channelOf(base: string, listener: Listener): Channel {
  const events = new EventSource(`${base}api/events`);

  events.addEventListener("open", () => listener.connected(true));
  events.addEventListener("error", () => listener.connected(false));

  events.addEventListener("message", (message: MessageEvent<string>) => {
    const event = parseEvent(JSON.parse(message.data));

    if (event === null)
      throw new Error(
        `pinpoint: the server streamed what the overlay cannot read: ${message.data}`,
      );
    listener.event(event);
  });

  return {
    send: async (selections) => {
      const request: BatchRequest = { selections };

      const response = await fetch(`${base}api/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }).catch(() => null);

      if (response === null) throw new Error(UNREACHABLE);

      if (!response.ok)
        throw new Error(`the server answered ${response.status}: ${await response.text()}`);
      const seq = parseSeq(await response.json());

      if (seq === null) throw new Error("the server answered without a batch number");

      return seq;
    },
  };
}
