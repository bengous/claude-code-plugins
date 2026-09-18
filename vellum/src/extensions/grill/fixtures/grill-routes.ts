import type { Route } from "../../../core/engine/fixtures/index.ts";
import { reply, WORKDIR } from "../../../core/engine/fixtures/index.ts";
import type { Relay } from "../protocol.ts";

export const GRILL_NAME = "grill-1.md";

export const OPENED: Relay = { kind: "opened", seq: 0, name: GRILL_NAME, subject: "auth" };

/** Every entry of the last grill, in file order: the route cuts them at the module's cursor, as the server does. */
export type Grill = { readonly open: boolean; readonly relays: readonly Relay[] };

export const NO_GRILL: Grill = { open: false, relays: [] };

export function openGrill(...replies: string[]): Grill {
  const relays = replies.map((text, index): Relay => ({ kind: "reply", seq: index + 1, text }));

  return { open: true, relays: [OPENED, ...relays] };
}

/** The same grill once the reviewer ended it from the page. */
export function endedGrill(...replies: string[]): Grill {
  const { relays } = openGrill(...replies);

  return {
    open: false,
    relays: [...relays, { kind: "ended", seq: relays.length, name: GRILL_NAME }],
  };
}

export type GrillRoutes = {
  readonly routes: Record<string, Route>;
  readonly posted: [name: string, body: string][];
};

function nameOf(relays: readonly Relay[]): string {
  const [first] = relays;

  return first?.kind === "opened" ? first.name : GRILL_NAME;
}

/** The grill routes a review server answers, and every body the module posted there, by route name. */
export function grillRoutes(
  grill: () => Grill,
  answers: Readonly<Record<string, Route>> = {},
): GrillRoutes {
  const posted: [name: string, body: string][] = [];
  const names = ["ask", "suggest", "event", "answer", "close"];

  const post =
    (name: string): Route =>
    (body, query) => {
      posted.push([name, body ?? ""]);

      return answers[name]?.(body, query) ?? reply(204, null);
    };

  const state: Route = (_, query) => {
    const { open, relays } = grill();
    const after = query.get("file") === nameOf(relays) ? Number(query.get("after")) : -1;
    const due = relays.filter((relay) => relay.seq > after);

    return reply(
      200,
      open
        ? {
            kind: "open",
            file: `${WORKDIR}${nameOf(relays)}`,
            subject: "auth",
            phase: "working",
            relays: due,
          }
        : { kind: "none", suggestion: null, relays: due },
    );
  };

  return {
    posted,
    routes: {
      "/api/x/grill/state": state,
      ...Object.fromEntries(names.map((name) => [`/api/x/grill/${name}`, post(name)])),
    },
  };
}
