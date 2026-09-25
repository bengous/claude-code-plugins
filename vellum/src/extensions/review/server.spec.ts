import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../../core/server/adapters/http/serve.ts";
import type { Started } from "../../core/server/adapters/http/serve.ts";
import { parseWipDir } from "../../core/server/domain/paths.ts";
import type { Requested, ReviewPosts, ReviewState } from "./protocol.ts";

const WIP = "plans/2026-09-25/wip-c95eaf71/";

const OPUS = "claude-opus-5-5";

const VERDICT = "## Plan review\n\nStatus: Approved\n\nVerdict: right - one slice per concern";

const running: Started[] = [];

type Reviewing = {
  readonly dir: string;
  readonly post: <Name extends keyof ReviewPosts>(
    name: Name,
    body: ReviewPosts[Name],
  ) => Promise<Response>;
  readonly state: () => Promise<ReviewState>;
  /** `POST request` on `version`, answered with the number the run took. */
  readonly request: (version?: number) => Promise<number>;
  /** A run asked, then launched as the hooks module does, on `version`. */
  readonly launch: (version?: number, model?: string) => Promise<number>;
  /** `POST /api/gate`: `plan.md` recorded as the next version. */
  readonly gate: () => Promise<Response>;
  readonly approve: () => Promise<Response>;
  /** The files of the working directory's `reviews/`, sorted. */
  readonly reviews: () => readonly string[];
  readonly read: (name: string) => string;
  /** The server on the same directory, stopped and started again. */
  readonly restart: () => Promise<Reviewing>;
};

async function serving(dir: string): Promise<Reviewing> {
  const workdir = parseWipDir(WIP);

  if (!workdir.ok) throw new Error(workdir.error);
  const started = await startServer({ project: dir, workdir: workdir.value, port: 0 });
  running.push(started);
  const headers = { "x-vellum-token": started.token, "content-type": "application/json" };
  const base = `http://127.0.0.1:${started.server.port}/api/`;

  const api = (path: string, body?: string): Promise<Response> =>
    body === undefined
      ? fetch(`${base}${path}`, { headers })
      : fetch(`${base}${path}`, { method: "POST", headers, body });

  const post: Reviewing["post"] = (name, body) => api(`x/review/${name}`, JSON.stringify(body));

  const request = async (version = 1): Promise<number> => {
    const response = await post("request", { version });

    if (!response.ok) throw new Error(`request answered ${response.status}`);

    // SAFETY: the server's own `Requested`, serialized by `Response.json` in review/server.ts.
    return ((await response.json()) as Requested).seq;
  };

  const reviewsDir = join(dir, WIP, "reviews");

  return {
    dir,
    post,
    // SAFETY: the server's own `ReviewState`, serialized by `Response.json` in review/server.ts.
    state: async () => (await (await api("x/review/state")).json()) as ReviewState,
    request,
    launch: async (version = 1, model = OPUS) => {
      const seq = await request(version);
      await post("launched", { seq, agentId: `agent-${seq}`, model });

      return seq;
    },
    gate: () => api("gate", "{}"),
    approve: () => api("decision", JSON.stringify({ kind: "approve", edit: null, notes: "" })),
    reviews: () => (existsSync(reviewsDir) ? readdirSync(reviewsDir).toSorted() : []),
    read: (name) => readFileSync(join(reviewsDir, name), "utf8"),
    restart: async () => {
      started.stop();

      return await serving(dir);
    },
  };
}

/** A server on a fresh working directory whose `plan.md` is recorded as v1. */
async function reviewing(): Promise<Reviewing> {
  const dir = mkdtempSync(join(tmpdir(), "vellum-review-"));
  mkdirSync(join(dir, WIP), { recursive: true });
  writeFileSync(join(dir, WIP, "plan.md"), "# Plan\n\n## Decisions\n\n1. One.\n");
  const served = await serving(dir);
  await served.gate();

  return served;
}

afterEach(() => {
  for (const started of running.splice(0)) started.stop();
});

describe("a review asked from the page", () => {
  test("takes a number and waits to be launched", async () => {
    const { request, state } = await reviewing();

    expect(await request(1)).toBe(1);
    expect(await state()).toEqual({ run: { kind: "requested", seq: 1, version: 1 }, failed: null });
  });

  test("is refused while drafting, on another version, and while a run is under way", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vellum-review-"));
    const drafting = await serving(dir);

    expect((await drafting.post("request", { version: 1 })).status).toBe(409);
    const { post, request } = await reviewing();

    expect((await post("request", { version: 2 })).status).toBe(409);
    await request(1);

    expect((await post("request", { version: 1 })).status).toBe(409);
  });

  test("that is not one is a bad request", async () => {
    const { post, state } = await reviewing();

    expect((await post("request", { version: 0 })).status).toBe(400);
    expect((await state()).run).toBeNull();
  });
});

describe("a run launched", () => {
  test("runs under its agent and model", async () => {
    const { launch, state } = await reviewing();
    await launch(1, OPUS);

    expect((await state()).run).toEqual({
      kind: "running",
      seq: 1,
      version: 1,
      agentId: "agent-1",
      model: OPUS,
    });
  });

  test("launched or ended under another number is refused and changes nothing", async () => {
    const { post, request, state } = await reviewing();
    const seq = await request(1);
    const before = await state();

    expect((await post("launched", { seq: seq + 1, agentId: "a", model: OPUS })).status).toBe(409);
    expect(
      (await post("ended", { seq: seq + 1, outcome: { kind: "failed", why: "error" } })).status,
    ).toBe(409);
    expect(await state()).toEqual(before);
  });

  test("a launch refused ends the run as failed, with no model", async () => {
    const { post, request, state } = await reviewing();
    const seq = await request(1);
    await post("ended", { seq, outcome: { kind: "failed", why: "no such agent" } });

    expect(await state()).toEqual({
      run: null,
      failed: { seq, version: 1, model: null, why: "no such agent" },
    });
  });

  test("a run that ends without a verdict leaves the failure and no file", async () => {
    const { post, launch, state, reviews } = await reviewing();
    const seq = await launch(1, OPUS);
    await post("ended", { seq, outcome: { kind: "failed", why: "aborted" } });

    expect(await state()).toEqual({
      run: null,
      failed: { seq, version: 1, model: OPUS, why: "aborted" },
    });
    expect(reviews()).toEqual([]);
  });

  test("the next request clears the last failure", async () => {
    const { post, request, state } = await reviewing();
    const seq = await request(1);
    await post("ended", { seq, outcome: { kind: "failed", why: "error" } });
    await request(1);

    expect((await state()).failed).toBeNull();
  });
});

describe("the verdict", () => {
  test("is written under the version and the model, the agent's text under vellum's header", async () => {
    const { post, launch, state, reviews, read } = await reviewing();
    const seq = await launch(1, OPUS);

    expect((await post("ended", { seq, outcome: { kind: "answer", text: VERDICT } })).status).toBe(
      204,
    );
    expect(reviews()).toEqual(["v1-claude-opus-5-5.md"]);
    expect(read("v1-claude-opus-5-5.md")).toMatch(
      /^# Plan review · v1\n\n`vellum:plan-reviewer` · `claude-opus-5-5` · \d\d:\d\d\n\n## Plan review\n\nStatus: Approved\n\nVerdict: right - one slice per concern\n$/u,
    );
    expect(await state()).toEqual({ run: null, failed: null });
  });

  test("a second review by the same model on the same version writes -2 and leaves the first", async () => {
    const { post, launch, reviews, read } = await reviewing();
    const first = await launch(1, OPUS);
    await post("ended", { seq: first, outcome: { kind: "answer", text: "first" } });
    const kept = read("v1-claude-opus-5-5.md");
    const second = await launch(1, OPUS);
    await post("ended", { seq: second, outcome: { kind: "answer", text: "second" } });

    expect(reviews()).toEqual(["v1-claude-opus-5-5-2.md", "v1-claude-opus-5-5.md"]);
    expect(read("v1-claude-opus-5-5.md")).toBe(kept);
    expect(read("v1-claude-opus-5-5-2.md")).toEndWith("\n\nsecond\n");
  });

  test("a model id with a bracket is named without it", async () => {
    const { post, launch, reviews } = await reviewing();
    const seq = await launch(1, "claude-opus-5-5[1m]");
    await post("ended", { seq, outcome: { kind: "answer", text: "ok" } });

    expect(reviews()).toEqual(["v1-claude-opus-5-51m.md"]);
  });

  test("an empty answer is a bad request, and the run goes on", async () => {
    const { post, launch, state } = await reviewing();
    const seq = await launch(1, OPUS);

    expect((await post("ended", { seq, outcome: { kind: "answer", text: " \n" } })).status).toBe(
      400,
    );
    expect((await state()).run?.kind).toBe("running");
  });

  test("an answer to a run never launched is refused", async () => {
    const { post, request, reviews } = await reviewing();
    const seq = await request(1);

    expect((await post("ended", { seq, outcome: { kind: "answer", text: "x" } })).status).toBe(409);
    expect(reviews()).toEqual([]);
  });
});

describe("a run given up", () => {
  test("forgotten from the page: its late answer is refused and writes nothing", async () => {
    const { post, launch, state, reviews } = await reviewing();
    const seq = await launch(1, OPUS);

    expect((await post("forget", { seq })).status).toBe(204);
    expect(await state()).toEqual({ run: null, failed: null });
    expect((await post("ended", { seq, outcome: { kind: "answer", text: "x" } })).status).toBe(409);
    expect(reviews()).toEqual([]);
  });

  test("closed by /vellum:stop: its late answer is refused and writes nothing", async () => {
    const { post, launch, state, reviews } = await reviewing();
    const seq = await launch(1, OPUS);

    expect((await post("close", {})).status).toBe(204);
    expect((await state()).run).toBeNull();
    expect((await post("ended", { seq, outcome: { kind: "answer", text: "x" } })).status).toBe(409);
    expect(reviews()).toEqual([]);
  });

  test("dropped by the approval: its late answer is refused and writes nothing", async () => {
    const { post, launch, approve, state } = await reviewing();
    const seq = await launch(1, OPUS);

    expect((await approve()).status).toBe(200);
    expect((await state()).run).toBeNull();
    expect((await post("ended", { seq, outcome: { kind: "answer", text: "x" } })).status).toBe(409);
  });

  test("forget under another number is refused", async () => {
    const { post, request } = await reviewing();
    const seq = await request(1);

    expect((await post("forget", { seq: seq + 1 })).status).toBe(409);
  });
});

describe("what the server keeps", () => {
  test("a restarted server knows the run and the numbers it gave", async () => {
    const { launch, restart } = await reviewing();
    await launch(1, OPUS);
    const again = await restart();

    expect((await again.state()).run?.kind).toBe("running");
    expect((await again.post("forget", { seq: 1 })).status).toBe(204);
    expect(await again.request(1)).toBe(2);
  });

  test("no route writes the reviewer's draft", async () => {
    const { dir, post, launch } = await reviewing();
    const draft = join(dir, WIP, ".review/draft.json");
    writeFileSync(draft, '{"annotations":[],"edit":null}');
    const seq = await launch(1, OPUS);
    await post("ended", { seq, outcome: { kind: "answer", text: "x" } });
    const other = await launch(1, OPUS);
    await post("forget", { seq: other });
    await post("close", {});

    expect(readFileSync(draft, "utf8")).toBe('{"annotations":[],"edit":null}');
  });
});
