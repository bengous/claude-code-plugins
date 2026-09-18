import type { Route } from "../../../core/engine/fixtures/index.ts";
import { reply, WORKDIR } from "../../../core/engine/fixtures/index.ts";

export const GRILL_FILE = `${WORKDIR}grill-1.md`;

/** `GET state` of an open grill whose reviewer's entry waits for the relay: 0 is the opening, n their nth reply. */
export function openState(round: number, text: string) {
  return {
    kind: "open",
    file: GRILL_FILE,
    subject: "auth",
    phase: "working",
    reviewer: { file: GRILL_FILE, round, text },
  };
}

export type GrillRoutes = {
  readonly routes: Record<string, Route>;
  readonly posted: [name: string, body: string][];
};

/** The grill routes a review server answers, and every body the module posted there, by route name. */
export function grillRoutes(
  // oxlint-disable-next-line anti-slop/no-object-parameters -- the server's `GrillState` as JSON; the module parses it at its own boundary, which is the code under test.
  state: () => object,
  answers: Readonly<Record<string, Route>> = {},
): GrillRoutes {
  const posted: [name: string, body: string][] = [];
  const names = ["ask", "suggest", "event", "answer", "close"];

  const post =
    (name: string): Route =>
    (body) => {
      posted.push([name, body ?? ""]);

      return answers[name]?.(body) ?? reply(204, null);
    };

  return {
    posted,
    routes: {
      "/api/x/grill/state": () => reply(200, state()),
      ...Object.fromEntries(names.map((name) => [`/api/x/grill/${name}`, post(name)])),
    },
  };
}
