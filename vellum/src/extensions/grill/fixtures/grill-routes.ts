import type { Route } from "../../../core/engine/fixtures/index.ts";
import { reply, WORKDIR } from "../../../core/engine/fixtures/index.ts";
import type { Proposal } from "../protocol.ts";

export const GRILL_NAME = "grill-1.md";

/** Whether the last grill is open, and with none open, what the proposal slot holds, as the server serves it. */
export type Grill = { readonly open: boolean; readonly proposal?: Proposal };

export const NO_GRILL: Grill = { open: false };

export const OPEN_GRILL: Grill = { open: true };

export type GrillRoutes = {
  readonly routes: Record<string, Route>;
  readonly posted: [name: string, body: string][];
};

/**
 * The grill routes a review server answers, and every body the module posted there, by route
 * name: 204 unless `answers` names the route, and a route that answers `null` is one the server
 * does not answer, so the module's call rejects.
 */
export function grillRoutes(
  grill: () => Grill,
  answers: Readonly<Record<string, Route>> = {},
): GrillRoutes {
  const posted: [name: string, body: string][] = [];
  const names = ["ask", "wait", "suggest", "event", "answer", "close"];

  const post =
    (name: string): Route =>
    (body, query) => {
      posted.push([name, body ?? ""]);

      const answer = answers[name];

      return answer === undefined ? reply(204, null) : answer(body, query);
    };

  const state: Route = () => {
    const { open, proposal = null } = grill();

    return reply(
      200,
      open
        ? { kind: "open", file: `${WORKDIR}${GRILL_NAME}`, subject: "auth", phase: "working" }
        : { kind: "none", proposal },
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
