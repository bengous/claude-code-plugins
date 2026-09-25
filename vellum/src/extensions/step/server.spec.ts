import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChannelLine } from "../../core/protocol.ts";
import { startServer } from "../../core/server/adapters/http/serve.ts";
import type { Started } from "../../core/server/adapters/http/serve.ts";
import { Review } from "../../core/server/app/review.ts";
import { parseWipDir } from "../../core/server/domain/paths.ts";
import { serverExtensions } from "../server.ts";
import type { Move, Proposal, Proposed, StepPosts, StepState, StepWaited } from "./protocol.ts";
import { stepServer } from "./server.ts";

const WIP = "plans/2026-09-17/wip-c95eaf71/";

const GRILL: Move = { kind: "grill", subject: "auth", choices: ["Sessions", "Tokens"] };

const MOCKUP: Move = { kind: "mockup", screen: "the settings window" };

const PROPOSAL: Proposal = {
  reason: "Two choices change the interface.",
  moves: [GRILL, MOCKUP, { kind: "plan" }],
  recommended: 0,
};

const OPENED_FIRST =
  /^The reviewer opened grill-1\.md on: auth\. Read \/.+\/src\/extensions\/grill\/grilling\.md, then ask with mcp__vellum__grill_ask\.$/u;

const running: Started[] = [];

type Stepping = {
  readonly dir: string;
  readonly post: <Name extends keyof StepPosts>(
    name: Name,
    body: StepPosts[Name],
  ) => Promise<Response>;
  /** `POST propose`, answered with the id the proposal waits under. */
  readonly propose: (proposal?: Proposal) => Promise<string>;
  readonly state: () => Promise<StepState>;
  readonly wait: (id: string) => Promise<StepWaited>;
  /** A route of the core's, or of another extension's: a GET without a body, a POST with one. */
  readonly api: (path: string, body?: string) => Promise<Response>;
  /** What the channel told Claude, each text in order. */
  readonly told: () => Promise<readonly string[]>;
};

/** A server on a fresh working directory, its step routes behind the token. */
async function stepping(): Promise<Stepping> {
  const dir = mkdtempSync(join(tmpdir(), "vellum-step-"));
  const workdir = parseWipDir(WIP);

  if (!workdir.ok) throw new Error(workdir.error);
  const started = await startServer({ project: dir, workdir: workdir.value, port: 0 });
  running.push(started);
  const headers = { "x-vellum-token": started.token, "content-type": "application/json" };

  const api = (path: string, body?: string): Promise<Response> => {
    const url = `http://127.0.0.1:${started.server.port}/api/${path}`;

    return body === undefined
      ? fetch(url, { headers })
      : fetch(url, { method: "POST", headers, body });
  };

  const post: Stepping["post"] = (name, body) => api(`x/step/${name}`, JSON.stringify(body));

  return {
    dir,
    post,
    api,
    propose: async (proposal = PROPOSAL) => {
      const response = await post("propose", proposal);

      if (!response.ok) throw new Error(`propose answered ${response.status}`);
      // SAFETY: the server's own `Proposed`, serialized by `Response.json` in step/server.ts.
      const proposed = (await response.json()) as Proposed;

      return proposed.id;
    },
    // SAFETY: the server's own `StepState`, serialized by `Response.json` in step/server.ts.
    state: async () => (await (await api("x/step/state")).json()) as StepState,
    // SAFETY: the server's own `StepWaited`, serialized by `Response.json` in step/server.ts.
    wait: async (id) => (await (await post("wait", { id })).json()) as StepWaited,
    told: async () => {
      // SAFETY: the server's own `ChannelLine[]`, serialized by `Response.json` in routes.ts.
      const lines = (await (await api("channel?after=0")).json()) as readonly ChannelLine[];

      return lines.flatMap(({ entry }) => (entry.kind === "text" ? [entry.text] : []));
    },
  };
}

afterEach(() => {
  for (const started of running.splice(0)) started.stop();
});

describe("a proposal", () => {
  test("waits under an id the server gave it, and the page reads it", async () => {
    const { propose, state } = await stepping();
    const id = await propose();

    expect(await state()).toEqual({ pending: { id, proposal: PROPOSAL } });
  });

  test("a new one replaces it under a new id, and a wait on the first reads it gone", async () => {
    const { propose, state, wait } = await stepping();
    const first = await propose();
    const second = await propose({ ...PROPOSAL, recommended: 1 });

    expect(second).not.toBe(first);
    expect((await state()).pending?.id).toBe(second);
    expect(await wait(first)).toEqual({ kind: "ended", why: "replaced" });
  });

  test("that is not one is a bad request, and takes nothing", async () => {
    const { post, state } = await stepping();

    const wrong = [
      { ...PROPOSAL, moves: [] },
      { ...PROPOSAL, recommended: 3 },
      { ...PROPOSAL, recommended: 0.5 },
      { ...PROPOSAL, reason: " " },
      { ...PROPOSAL, moves: [{ kind: "grill", subject: "auth\n### Reviewer", choices: [] }] },
      { ...PROPOSAL, moves: [{ kind: "grill", subject: "auth", choices: [""] }] },
      { ...PROPOSAL, moves: [{ kind: "mockup", screen: "" }] },
      { ...PROPOSAL, moves: [{ kind: "survey" }] },
    ];

    for (const body of wrong) {
      // @ts-expect-error -- what the server must refuse is not a `Proposal`.
      expect((await post("propose", body)).status).toBe(400);
    }

    expect((await state()).pending).toBeNull();
  });

  test("a grill's choices left out are none", async () => {
    const { post, state } = await stepping();

    await post("propose", {
      ...PROPOSAL,
      // @ts-expect-error -- the tool's input may leave a grill's choices out.
      moves: [{ kind: "grill", subject: "auth" }],
    });

    expect((await state()).pending?.proposal.moves).toEqual([
      { kind: "grill", subject: "auth", choices: [] },
    ]);
  });

  test("is refused while a grill is open, with what holds the review", async () => {
    const { post, propose } = await stepping();
    const id = await propose();
    await post("answer", { id, answer: { kind: "move", move: GRILL } });

    const refused = await post("propose", PROPOSAL);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "grill 1 is open: no step is proposed until the reviewer ends it",
    });
  });

  test("is refused once the plan is approved, and the approval takes the one waiting", async () => {
    const { dir, api, post, propose, wait } = await stepping();
    const id = await propose();
    writeFileSync(join(dir, WIP, "plan.md"), "# Auth plan\n");
    await api("gate", "{}");
    await api("decision", JSON.stringify({ kind: "approve", edit: null, notes: "" }));

    expect(await wait(id)).toEqual({ kind: "ended", why: "approved" });
    expect((await post("propose", PROPOSAL)).status).toBe(409);
  });
});

describe("an answer", () => {
  test("the move Claude recommended is Accepted, told once, and the wait returns it under its entry", async () => {
    const { post, propose, state, told, wait } = await stepping();
    const id = await propose({ ...PROPOSAL, recommended: 1 });

    expect((await post("answer", { id, answer: { kind: "move", move: MOCKUP } })).status).toBe(204);
    expect(await told()).toEqual(["Accepted: a mockup of: the settings window."]);
    expect(await wait(id)).toEqual({
      kind: "answered",
      seq: 1,
      text: "Accepted: a mockup of: the settings window.",
    });
    expect((await state()).pending).toBeNull();
  });

  test("another move offered is Chose; the reviewer's own words are Own", async () => {
    const { post, propose, told } = await stepping();
    const first = await propose({ ...PROPOSAL, recommended: 1 });
    await post("answer", { id: first, answer: { kind: "move", move: { kind: "plan" } } });
    const second = await propose();
    await post("answer", { id: second, answer: { kind: "own", text: "Read the issue first" } });
    const third = await propose();
    await post("answer", { id: third, answer: { kind: "own", text: "Why?" } });

    expect(await told()).toEqual(["Chose: the plan.", "Own: Read the issue first.", "Own: Why?"]);
  });

  test("a grill accepted opens in the same step: its transcript, and Claude told the guide in the same entry", async () => {
    const { dir, post, propose, state, told, wait } = await stepping();
    const id = await propose();
    await post("answer", { id, answer: { kind: "move", move: GRILL } });

    expect(existsSync(join(dir, WIP, "grill-1.md"))).toBe(true);
    const [text] = await told();
    expect(text?.startsWith("Accepted: a grill on: auth. ")).toBe(true);
    expect(text?.slice("Accepted: a grill on: auth. ".length)).toMatch(OPENED_FIRST);
    expect(await wait(id)).toMatchObject({ kind: "answered", seq: 1 });
    expect(await state()).toEqual({ pending: null });
  });

  test("the window opened blank answers what waits: a grill of the reviewer's own settles it", async () => {
    const { post, propose, told, wait } = await stepping();
    const id = await propose();
    const own: Move = { kind: "grill", subject: "Where do drafts live?", choices: [] };
    await post("answer", { id: null, answer: { kind: "move", move: own } });

    expect(await told()).toEqual([
      expect.stringMatching(
        /^The reviewer answered from their own window, without opening your proposal\. Chose: a grill on: Where do drafts live\? The reviewer opened/u,
      ),
    ]);
    expect(await wait(id)).toMatchObject({ kind: "answered", seq: 1 });
  });

  test("the window opened blank never reads against the recommendation it did not show", async () => {
    const { post, propose, told } = await stepping();
    await propose({ ...PROPOSAL, recommended: 2 });
    await post("answer", { id: null, answer: { kind: "move", move: { kind: "plan" } } });

    expect(await told()).toEqual([
      "The reviewer answered from their own window, without opening your proposal. Chose: the plan.",
    ]);
  });

  test("an answer whose entry cannot be written opens no grill, and the proposal still waits", async () => {
    const { dir, post, propose, state } = await stepping();
    const id = await propose();
    rmSync(join(dir, WIP, ".review/channel.jsonl"));
    mkdirSync(join(dir, WIP, ".review/channel.jsonl"));

    const failed = await post("answer", { id, answer: { kind: "move", move: GRILL } });

    expect(failed.ok).toBe(false);
    expect(existsSync(join(dir, WIP, "grill-1.md"))).toBe(false);
    expect((await state()).pending?.id).toBe(id);
  });

  test("the window opened blank with nothing waiting tells Claude all the same", async () => {
    const { post, told } = await stepping();
    await post("answer", { id: null, answer: { kind: "own", text: "Look at the tests first" } });

    expect(await told()).toEqual(["Own: Look at the tests first."]);
  });

  test("an answer to a proposal no longer waiting is refused, and tells nothing", async () => {
    const { post, propose, told } = await stepping();
    const first = await propose();
    await propose();

    const late = await post("answer", { id: first, answer: { kind: "move", move: MOCKUP } });

    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "no such proposal" });
    expect(await told()).toEqual([]);
  });

  test("no second grill: an answer while one is open is refused, and opens nothing", async () => {
    const { dir, post, told } = await stepping();
    await post("answer", { id: null, answer: { kind: "move", move: GRILL } });

    const again = await post("answer", { id: null, answer: { kind: "move", move: GRILL } });

    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "grill 1 is open" });
    expect(existsSync(join(dir, WIP, "grill-2.md"))).toBe(false);
    expect(await told()).toHaveLength(1);
  });

  test("two grills answered together open one", async () => {
    const { dir, post } = await stepping();
    const grill = { id: null, answer: { kind: "move", move: GRILL } } as const;

    const statuses = await Promise.all([post("answer", grill), post("answer", grill)]);

    expect(statuses.map(({ status }) => status).toSorted()).toEqual([204, 409]);
    expect(existsSync(join(dir, WIP, "grill-2.md"))).toBe(false);
  });

  test("that is not one is a bad request", async () => {
    const { post } = await stepping();

    const wrong = [
      { id: null, answer: { kind: "own", text: " " } },
      { id: "", answer: { kind: "move", move: MOCKUP } },
      { id: null, answer: { kind: "move", move: { kind: "grill", subject: "a\nb" } } },
      { id: null },
    ];

    for (const body of wrong) {
      // @ts-expect-error -- what the server must refuse is not an answer.
      expect((await post("answer", body)).status).toBe(400);
    }
  });
});

/** A step route's request, as `serve.ts` hands it on: the body is all a step route reads. */
function request(body?: StepPosts["propose"] | StepPosts["answer"]): Request {
  return body === undefined
    ? new Request("http://step/")
    : new Request("http://step/", { method: "POST", body: JSON.stringify(body) });
}

describe("the page", () => {
  test("hears of an answer that opens a grill once, once the proposal is settled", async () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-step-"));
    mkdirSync(join(root, WIP, ".review"), { recursive: true });
    const workdir = parseWipDir(WIP);

    if (!workdir.ok) throw new Error(workdir.error);
    const extensions = serverExtensions;
    const review = new Review({ project: root, workdir: workdir.value, extensions });
    await review.openChannel();

    const routes = stepServer.routes?.(review.context);

    const [propose, answer, state] = [
      routes?.["POST propose"],
      routes?.["POST answer"],
      routes?.["GET state"],
    ];

    if (propose === undefined || answer === undefined || state === undefined) {
      throw new Error("a step route is missing");
    }

    // SAFETY: the server's own `Proposed`, serialized by `Response.json` in step/server.ts.
    const { id } = (await (await propose(request(PROPOSAL))).json()) as Proposed;
    const heard: Promise<Response>[] = [];
    review.subscribe(() => heard.push(state(request())));
    await answer(request({ id, answer: { kind: "move", move: GRILL } }));

    expect(heard).toHaveLength(1);
    expect(await heard[0]?.then((read) => read.json())).toEqual({ pending: null });
  });
});

describe("a wait", () => {
  test("on an id the server does not know reads gone: a restarted server lost the proposal", async () => {
    const { wait } = await stepping();

    expect(await wait("f3b1")).toEqual({ kind: "gone" });
  });

  test("held on a proposal waiting answers once the reviewer does", async () => {
    const { post, propose, wait } = await stepping();
    const id = await propose();
    const waiting = wait(id);
    await post("answer", { id, answer: { kind: "move", move: MOCKUP } });

    expect(await waiting).toEqual({
      kind: "answered",
      seq: 1,
      text: "Chose: a mockup of: the settings window.",
    });
  });

  test("that names no proposal is a bad request", async () => {
    const { post } = await stepping();

    // @ts-expect-error -- what the server must refuse is not a wait.
    expect((await post("wait", {})).status).toBe(400);
  });
});
