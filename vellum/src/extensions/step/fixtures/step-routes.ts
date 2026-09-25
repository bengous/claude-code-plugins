import type { Route } from "../../../core/engine/fixtures/index.ts";
import { reply } from "../../../core/engine/fixtures/index.ts";

/** The id the review server gave the proposal, unless a test answers `propose` itself. */
export const PROPOSED_ID = "3f0c9a1e";

export type StepRoutes = {
  readonly routes: Record<string, Route>;
  readonly posted: [name: string, body: string][];
};

/**
 * The step routes a review server answers, and every body the module posted there, by route
 * name: `propose` takes the proposal under `PROPOSED_ID` and any other answers 204, unless
 * `answers` names the route, and a route that answers `null` is one the server does not answer,
 * so the module's call rejects.
 */
export function stepRoutes(answers: Readonly<Record<string, Route>> = {}): StepRoutes {
  const posted: [name: string, body: string][] = [];

  const proposed: Route = () => reply(200, { id: PROPOSED_ID });

  const post =
    (name: string): Route =>
    (body, query) => {
      posted.push([name, body ?? ""]);

      const answer = answers[name] ?? (name === "propose" ? proposed : undefined);

      return answer === undefined ? reply(204, null) : answer(body, query);
    };

  return {
    posted,
    routes: Object.fromEntries(
      ["propose", "wait", "answer"].map((name) => [`/api/x/step/${name}`, post(name)]),
    ),
  };
}
