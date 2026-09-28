import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HooksContext, HooksHalf } from "../../core/engine/extension.ts";
import { engineExtension } from "../../core/engine/slice.ts";
import type {
  Bodies,
  Dispatched,
  PageHalf,
  RouteKey,
  ServerHalf,
  SliceContext,
} from "../../core/extension.ts";
import type { Json } from "../../core/plugs.ts";
import { Review } from "../../core/server/app/review.ts";
import { parseWipDir } from "../../core/server/domain/paths.ts";
import type { Carried, Guard, Transitions } from "../../core/server/domain/rows.ts";
import { rows, tablePart } from "../../core/server/domain/rows.ts";
import type { Workflow } from "../../core/server/domain/workflow.ts";
import { serverExtension } from "../../core/server/slice.ts";
import type { StepEvents, StepPlugs } from "./contract.ts";
import { EVENTS } from "./contract.ts";
import { hooks } from "./hooks.ts";
import { page } from "./page.tsx";
import { BODIES, parseProposal } from "./parse.ts";
import { noProposalWaits, offersPlan, regionOf, TRANSITIONS } from "./proposal.ts";
import { server } from "./server.ts";

/**
 * What the contract makes a compile error, one test each: the code under `@ts-expect-error` is
 * what must not compile, and the line after it runs, to say what that code would do.
 */

const WIP = "plans/2026-09-28/wip-c0417ac7/";

const DIR = parseWipDir(WIP);

if (!DIR.ok) throw new Error(DIR.error);

const WORKDIR = DIR.value;

const W: Workflow = {
  workspace: { kind: "drafting", dir: WORKDIR, batches: 0 },
  planText: "absent",
  regions: [regionOf(null)],
};

/** One route of `half`, mounted as the server mounts it, over a review on a fresh directory. */
function routeOf(half: ServerHalf<StepPlugs>, key: RouteKey): (body: Json) => Promise<Response> {
  const root = mkdtempSync(join(tmpdir(), "vellum-contract-"));
  mkdirSync(join(root, WIP, ".review"), { recursive: true });
  const extensions = [serverExtension(half)];
  const review = new Review({ project: root, workdir: WORKDIR, extensions });
  const route = serverExtension(half).routes?.(review.context)[key];

  if (route === undefined) throw new Error(`no route ${key}`);

  return (body) =>
    route(new Request("http://step/", { method: "POST", body: JSON.stringify(body) }));
}

/** A guard written for `pause`, reading a field `propose` carries. */
const readsProposal: Guard<Carried<StepEvents, "pause">> = (_w, input) =>
  // @ts-expect-error -- `pause` carries `id` alone.
  input.proposal === "";

const shown = (): boolean => true;

describe("hooks.ts fills the plugs' hooks, no more, no less (1)", () => {
  test("a hooks half without the declared tool does not compile: propose would not be registered", () => {
    // @ts-expect-error -- the plugs declare the tool `propose`.
    const half: HooksHalf<StepPlugs> = { ...hooks, tools: {} };

    expect(engineExtension(half).tools).toEqual([]);
  });

  test("a hooks half without the declared listener does not compile: a turn cut short would pause nothing", () => {
    // @ts-expect-error -- the plugs declare the listener `answered`.
    const half: HooksHalf<StepPlugs> = { id: "step", tools: hooks.tools };

    expect(engineExtension(half).answered).toBeUndefined();
  });

  test("a tool the plugs do not declare does not compile: it would be registered", () => {
    const half: HooksHalf<StepPlugs> = {
      ...hooks,
      // @ts-expect-error -- the plugs declare the tool `propose` alone.
      tools: { propose: hooks.tools.propose, ask: hooks.tools.propose },
    };

    expect(engineExtension(half).tools?.map(({ name }) => name)).toEqual(["propose", "ask"]);
  });

  test("a listener the plugs do not declare does not compile: it would hear the mode close", () => {
    // @ts-expect-error -- the plugs declare the listener `answered` alone.
    const half: HooksHalf<StepPlugs> = { ...hooks, closing: async () => {} };

    expect(engineExtension(half).closing).toBeDefined();
  });
});

describe("server.ts fills the plugs' routes, each answering its declared answer (2)", () => {
  test("a server half without a declared route does not compile: the hooks module's pause would find none", () => {
    const { "POST pause": _pause, ...others } = server.routes;
    // @ts-expect-error -- the plugs declare `POST pause`.
    const half: ServerHalf<StepPlugs> = { ...server, routes: others };

    expect(() => routeOf(half, "POST pause")).toThrow("no route POST pause");
  });

  test("a route the plugs do not declare does not compile: it would be mounted", async () => {
    const half: ServerHalf<StepPlugs> = {
      ...server,
      // @ts-expect-error -- the plugs declare five routes, and `POST close` is none of them.
      routes: { ...server.routes, "POST close": () => Promise.resolve({ answer: null }) },
    };

    expect((await routeOf(half, "POST close")({})).status).toBe(204);
  });

  test("an answer other than the declared one does not compile: the hooks module would read it", async () => {
    const half: ServerHalf<StepPlugs> = {
      ...server,
      routes: {
        ...server.routes,
        // @ts-expect-error -- `POST pause` answers `{ wait: "paused" }`.
        "POST pause": () => Promise.resolve({ answer: { wait: "open" } }),
      },
    };

    expect(await (await routeOf(half, "POST pause")({ id: "p1" })).json()).toEqual({
      wait: "open",
    });
  });

  test("a route reads its body as its parser typed it: a field the body does not carry does not compile", async () => {
    const half: ServerHalf<StepPlugs> = {
      ...server,
      routes: {
        ...server.routes,
        // @ts-expect-error -- `POST pause` takes `{ id }`, which carries no `reason`.
        "POST pause": (_context, body) => Promise.resolve({ answer: { wait: body.reason } }),
      },
    };

    expect(await (await routeOf(half, "POST pause")({ id: "p1" })).json()).toEqual({});
  });

  test("a parser answering another body than its route's does not compile: the route would read a proposal as an id", () => {
    // @ts-expect-error -- `POST pause` takes `{ id }`, and `parseProposal` answers a proposal.
    const bodies: Bodies<StepPlugs["server"]> = { ...BODIES, "POST pause": parseProposal };

    expect(bodies["POST pause"]({ id: "p1" })).toBeNull();
  });
});

describe("the hooks half's client is typed by the same plugs (3)", () => {
  const REPLY = { status: 204, ok: true, headers: {}, text: "" };

  function recording(posted: string[]): HooksContext<StepPlugs>["post"] {
    return (route, body) => {
      posted.push(`${route} ${JSON.stringify(body)}`);

      return Promise.resolve(REPLY);
    };
  }

  test("posting a route the plugs do not declare does not compile: it would reach nothing", async () => {
    const posted: string[] = [];
    const post = recording(posted);

    // @ts-expect-error -- the step's routes hold no `POST close`.
    await post("POST close", { id: "p1" });

    expect(posted).toEqual(['POST close {"id":"p1"}']);
  });

  test("posting a GET route does not compile: the client posts", async () => {
    const posted: string[] = [];
    const post = recording(posted);

    // @ts-expect-error -- `GET state` takes no body, and the client posts.
    await post("GET state", { id: "p1" });

    expect(posted).toEqual(['GET state {"id":"p1"}']);
  });

  test("posting a body other than the route's does not compile: the server would answer 400", async () => {
    const posted: string[] = [];
    const post = recording(posted);

    // @ts-expect-error -- `POST pause` takes `{ id: string }`.
    await post("POST pause", { id: 7 });

    expect(posted).toEqual(['POST pause {"id":7}']);
  });
});

describe("the rows and the routes name the step's own events, with what each carries (4)", () => {
  const { refuse } = rows(EVENTS);

  test("a row on an event the step does not own does not compile: it would judge the core's approval", () => {
    // @ts-expect-error -- the step owns propose, wait, pause and answerProposal: `approve` is the core's.
    const row = refuse("approve", "no-proposal", noProposalWaits, "no proposal waits");

    expect(String(row.event)).toBe("approve");
  });

  test("a guard reading a field its event does not carry does not compile: every pause would throw", () => {
    // @ts-expect-error -- `pause` carries `id`, and `offersPlan` reads `proposal`.
    const row = refuse("pause", "plan", offersPlan, "the plan is offered");

    expect(() => row.when(W, { id: "p1" })).toThrow("not a proposal");
  });

  test("a guard written for an event reads only what that event carries", () => {
    expect(readsProposal(W, { id: "p1", at: "", seq: "" })).toBe(false);
  });

  test("a route dispatching an event without a field it carries does not compile", async () => {
    const sent: string[] = [];

    const DISPATCHED: Dispatched = {
      verdict: { kind: "allow" },
      workflow: W,
      effects: [],
      appended: [],
    };

    const dispatch: SliceContext<StepPlugs>["dispatch"] = (event) => {
      sent.push(event);

      return Promise.resolve(DISPATCHED);
    };

    // @ts-expect-error -- `propose` carries `id` and `proposal`.
    await dispatch("propose", { id: "p1" });
    // @ts-expect-error -- `record` is the core's event, not the step's.
    await dispatch("record", { unchanged: "keep" });

    expect(sent).toEqual(["propose", "record"]);
  });
});

describe("every event has its transition, every page slot its component (5)", () => {
  test("an event without a transition does not compile: next() would throw on it", () => {
    const { pause: _pause, ...others } = TRANSITIONS;
    // @ts-expect-error -- the step owns `pause`.
    const transitions: Transitions<StepEvents> = others;
    const part = tablePart("step", { ...server.workflow, transitions });

    expect(() => part.transitions.pause?.(W, "pause", { id: "p1" })).toThrow();
  });

  test("a page slot declared and not filled does not compile: the proposal's window would never draw", () => {
    // @ts-expect-error -- the plugs declare the slot `notices`.
    const half: PageHalf<StepPlugs> = { id: "step", actions: page.actions };

    expect(half.notices).toBeUndefined();
  });

  test("a page slot filled and not declared does not compile: a panel would open beside the documents", () => {
    // @ts-expect-error -- the plugs declare `actions` and `notices` alone.
    const half: PageHalf<StepPlugs> = { ...page, panel: { shown, component: () => null } };

    expect(half.panel).toBeDefined();
  });

  test("a half under another slice's id does not compile", () => {
    // @ts-expect-error -- the plugs name the slice `step`.
    const half: PageHalf<StepPlugs> = { ...page, id: "grill" };

    expect(String(half.id)).toBe("grill");
  });
});
