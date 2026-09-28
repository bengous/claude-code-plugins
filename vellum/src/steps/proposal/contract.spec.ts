import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Bodies,
  ErasedSliceContext,
  SliceDispatched,
  PageHalf,
  RouteKey,
  ServerHalf,
  SliceContext,
} from "../../runtime/extension.ts";
import type {
  Answers,
  HooksContext,
  HooksHalf,
  ToolAnswer,
} from "../../runtime/hooks/extension.ts";
import { engineExtension } from "../../runtime/hooks/slice.ts";
import { Review } from "../../runtime/server/review.ts";
import { serverExtension } from "../../runtime/server/slice.ts";
import { parseWipDir } from "../../workshop/paths.ts";
import type { Json } from "../../workshop/plugs.ts";
import type { Carried, Guard, Transitions } from "../../workshop/rows.ts";
import { rows, tablePart } from "../../workshop/rows.ts";
import type { Workflow } from "../../workshop/workflow.ts";
import type { Proposal, ProposalEvents, ProposalPlugs } from "./contract.ts";
import { SLICE } from "./contract.ts";
import { hooks } from "./hooks.ts";
import { page } from "./page.tsx";
import { BODIES, parseProposal, parseProposed } from "./parse.ts";
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

const PLAN_ONLY: Proposal = {
  reason: "The plan is next.",
  moves: [{ kind: "plan" }],
  recommended: 0,
};

const W: Workflow = {
  workspace: { kind: "drafting", dir: WORKDIR, batches: 0 },
  planText: "absent",
  regions: [regionOf(null)],
};

/** One route of `half`, mounted as the server mounts it, over a review on a fresh directory. */
function routeOf(
  half: ServerHalf<ProposalPlugs>,
  key: RouteKey,
): (body: Json) => Promise<Response> {
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
const readsProposal: Guard<Carried<ProposalEvents, "pause">> = (_w, input) =>
  // @ts-expect-error -- `pause` carries `id` alone.
  input.proposal === "";

const shown = (): boolean => true;

const answering = (): Promise<ToolAnswer> => Promise.resolve({ result: "" });

describe("hooks.ts fills the plugs' hooks, no more, no less (1)", () => {
  test("a hooks half without the declared tool does not compile: propose would not be registered", () => {
    // @ts-expect-error -- the plugs declare the tool `propose`.
    const half: HooksHalf<ProposalPlugs> = { ...hooks, tools: {} };

    expect(engineExtension(half).tools).toEqual([]);
  });

  test("a hooks half without the declared listener does not compile: a turn cut short would pause nothing", () => {
    // @ts-expect-error -- the plugs declare the listener `answered`.
    const half: HooksHalf<ProposalPlugs> = {
      id: "proposal",
      tools: hooks.tools,
      answers: hooks.answers,
    };

    expect(engineExtension(half).answered).toBeUndefined();
  });

  test("a tool the plugs do not declare does not compile: it would be registered", () => {
    const half: HooksHalf<ProposalPlugs> = {
      ...hooks,
      // @ts-expect-error -- the plugs declare the tool `propose` alone.
      tools: { propose: hooks.tools.propose, ask: hooks.tools.propose },
    };

    expect(engineExtension(half).tools?.map(({ name }) => name)).toEqual(["propose", "ask"]);
  });

  test("a listener the plugs do not declare does not compile: it would hear the mode close", () => {
    // @ts-expect-error -- the plugs declare the listener `answered` alone.
    const half: HooksHalf<ProposalPlugs> = { ...hooks, closing: async () => {} };

    expect(engineExtension(half).closing).toBeDefined();
  });
});

describe("server.ts fills the plugs' routes, each answering its declared answer (2)", () => {
  test("a server half without a declared route does not compile: the hooks module's pause would find none", () => {
    const { "POST pause": _pause, ...others } = server.routes;
    // @ts-expect-error -- the plugs declare `POST pause`.
    const half: ServerHalf<ProposalPlugs> = { ...server, routes: others };

    expect(() => routeOf(half, "POST pause")).toThrow("no route POST pause");
  });

  test("a route the plugs do not declare does not compile: it would be mounted", async () => {
    const half: ServerHalf<ProposalPlugs> = {
      ...server,
      // @ts-expect-error -- the plugs declare five routes, and `POST close` is none of them.
      routes: { ...server.routes, "POST close": () => Promise.resolve({ answer: null }) },
    };

    expect((await routeOf(half, "POST close")({})).status).toBe(204);
  });

  test("an answer other than the declared one does not compile: the hooks module would read it", async () => {
    const half: ServerHalf<ProposalPlugs> = {
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
    const half: ServerHalf<ProposalPlugs> = {
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
    const bodies: Bodies<ProposalPlugs["server"]> = { ...BODIES, "POST pause": parseProposal };

    expect(bodies["POST pause"]({ id: "p1" })).toBeNull();
  });
});

describe("the hooks half's client is typed by the same plugs (3)", () => {
  const REFUSED = { ok: false, status: 409, text: "", reason: null } as const;

  function recording(posted: string[]): HooksContext<ProposalPlugs>["post"] {
    return (route, body) => {
      posted.push(`${route} ${JSON.stringify(body)}`);

      return Promise.resolve(REFUSED);
    };
  }

  test("posting a route the server declares but the hooks half does not post does not compile", async () => {
    const posted: string[] = [];
    const post = recording(posted);

    // @ts-expect-error -- the hooks half posts propose, wait and pause: the answer is the page's.
    await post("POST answer", { id: null, answer: { kind: "own", text: "Why?" } });

    expect(posted).toHaveLength(1);
  });

  test("the client answers the route's declared answer: a field it does not carry does not compile", async () => {
    const posted = await recording([])("POST propose", PLAN_ONLY);

    // @ts-expect-error -- `POST propose` answers `{ id }`, which carries no `seq`.
    expect(posted.ok ? posted.answer.seq : null).toBeNull();
  });

  test("a parser in the hooks half's answers reading another route's answer does not compile: every wait would read an id", () => {
    // @ts-expect-error -- `POST wait` answers a `StepWaited`, and `parseProposed` reads `{ id }`.
    const answers: Answers<ProposalPlugs> = { ...hooks.answers, "POST wait": parseProposed };

    expect(JSON.stringify(answers["POST wait"]({ id: "p1" }))).toBe('{"id":"p1"}');
  });

  test("a route the hooks half posts that the server does not declare does not compile: nothing would answer it", () => {
    type Stray = Omit<ProposalPlugs, "hooks"> & {
      readonly hooks: Omit<ProposalPlugs["hooks"], "posts"> & {
        readonly posts: ProposalPlugs["hooks"]["posts"] | "POST close";
      };
    };

    // @ts-expect-error -- the server declares no `POST close`.
    const half: HooksHalf<Stray> = {
      id: "proposal",
      tools: { propose: { description: "", inputSchema: { type: "object" }, call: answering } },
      answers: { ...hooks.answers, "POST close": null },
      answered: () => Promise.resolve(),
    };

    expect(Object.keys(half.answers)).toContain("POST close");
  });

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
  const { refuse } = rows(SLICE);

  test("a row on an event the step neither owns nor hears does not compile: it would judge the core's version", () => {
    // @ts-expect-error -- the step owns propose, wait, pause and answerProposal, and hears approve, planWritten and sendEdit: `record` is none.
    const row = refuse("record", "no-proposal", noProposalWaits, 409, "no proposal waits");

    expect(String(row.event)).toBe("record");
  });

  test("a guard reading a field its event does not carry does not compile: every pause would throw", () => {
    // @ts-expect-error -- `pause` carries `id`, and `offersPlan` reads `proposal`.
    const row = refuse("pause", "plan", offersPlan, 409, "the plan is offered");

    expect(() => row.when(W, { id: "p1" })).toThrow("not a proposal");
  });

  test("a guard written for an event reads only what that event carries", () => {
    expect(readsProposal(W, { id: "p1", at: "", seq: "" })).toBe(false);
  });

  test("a route dispatching an event without a field it carries does not compile", async () => {
    const sent: string[] = [];

    const DISPATCHED: SliceDispatched = {
      verdict: { kind: "allow" },
      workflow: W,
      effects: [],
      appended: [],
    };

    const recorded: ErasedSliceContext["dispatch"] = (event) => {
      sent.push(event);

      return Promise.resolve(DISPATCHED);
    };

    const dispatch: SliceContext<ProposalPlugs>["dispatch"] = recorded;

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
    const transitions: Transitions<ProposalEvents> = others;
    const part = tablePart("proposal", { ...server.workflow, transitions });

    expect(() => part.transitions.pause?.(W, "pause", { id: "p1" })).toThrow();
  });

  test("a page slot declared and not filled does not compile: the proposal's window would never draw", () => {
    // @ts-expect-error -- the plugs declare the slot `notices`.
    const half: PageHalf<ProposalPlugs> = { id: "proposal", actions: page.actions };

    expect(half.notices).toBeUndefined();
  });

  test("a page slot filled and not declared does not compile: a panel would open beside the documents", () => {
    // @ts-expect-error -- the plugs declare `actions` and `notices` alone.
    const half: PageHalf<ProposalPlugs> = { ...page, panel: { shown, component: () => null } };

    expect(half.panel).toBeDefined();
  });

  test("a half under another slice's id does not compile", () => {
    // @ts-expect-error -- the plugs name the slice `step`.
    const half: PageHalf<ProposalPlugs> = { ...page, id: "grill" };

    expect(String(half.id)).toBe("grill");
  });
});
