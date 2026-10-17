import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BatchRequest, Delivery, Selection, ServerLine } from "../shared/wire.ts";
import { type Started, startServer } from "./serve.ts";

const APP = "http://localhost:5173";

const BATCH: BatchRequest = {
  selections: [
    {
      label: "Remove",
      note: "",
      targets: [
        {
          kind: "element",
          element: {
            selector: "body > div#ad",
            role: "",
            name: "",
            heading: "",
            openingTag: '<div id="ad">',
            text: "Buy now",
            box: { x: 0, y: 0, width: 300, height: 250 },
            styles: [],
          },
        },
      ],
      page: {
        url: `${APP}/`,
        title: "App",
        viewport: { width: 1280, height: 720 },
        scroll: { x: 0, y: 0 },
      },
      context: null,
    },
  ],
};

type Running = {
  readonly started: Started;
  readonly lines: ServerLine[];
  readonly dir: string;
  readonly closed: () => boolean;
};

const running: Running[] = [];

async function serve(
  dir: string | null = null,
  kept: { port: number; token: string } | null = null,
): Promise<Running> {
  const home = dir ?? (await mkdtemp(join(tmpdir(), "pinpoint-")));
  const lines: ServerLine[] = [];
  let closed = false;

  const started = await startServer({
    dir: home,
    session: "s1",
    root: "/work/app",
    port: kept?.port ?? 0,
    token: kept?.token,
    announce: (line) => lines.push(line),
    closed: () => {
      closed = true;
    },
    watchdog: { graceMs: 60_000, periodMs: 60_000, expire: () => {} },
  });

  const one = { started, lines, dir: home, closed: () => closed };
  running.push(one);

  return one;
}

function url(one: Running, path: string): string {
  return `http://127.0.0.1:${one.started.port}/t/${one.started.token}/${path}`;
}

/** What a test posts: a route's own body, one a parser must refuse, or none. */
type Posted =
  | BatchRequest
  | Delivery
  | { readonly selections: readonly Partial<Selection>[] }
  | Readonly<Record<string, never>>;

/** Posts `body` as the app's page would, or as the module does with `origin` null. */
function post(
  one: Running,
  path: string,
  body: Posted,
  origin: string | null = APP,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });

  if (origin !== null) headers.set("origin", origin);

  return fetch(url(one, path), { method: "POST", headers, body: JSON.stringify(body) });
}

/** Asks what became of `seqs`, as a page of the app does. */
function outcomes(one: Running, seqs: readonly (number | string)[]): Promise<Response> {
  const query = seqs.map((seq) => `seq=${seq}`).join("&");

  return fetch(url(one, `api/outcomes?${query}`), { headers: { origin: APP } });
}

afterEach(async () => {
  for (const one of running.splice(0)) {
    one.started.stop();
    await rm(one.dir, { recursive: true, force: true });
  }
});

describe("the server", () => {
  test("announces ready, writes its registry entry and the Vite module", async () => {
    const one = await serve();
    const entry = JSON.parse(await readFile(join(one.dir, "sessions/s1.json"), "utf8"));

    expect(one.lines[0]).toEqual({
      type: "ready",
      port: one.started.port,
      token: one.started.token,
    });
    expect(entry).toMatchObject({
      version: 1,
      session: "s1",
      root: "/work/app",
      port: one.started.port,
      pid: process.pid,
    });
    expect(existsSync(join(one.dir, "vite.mjs"))).toBe(true);
  });

  test("serves the overlay as a script", async () => {
    const one = await serve();
    const response = await fetch(url(one, "overlay.js"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toContain("pinpoint-overlay");
  });

  test("a batch is numbered, announced as the prompt's text, and kept until delivered", async () => {
    const one = await serve();
    const response = await post(one, "api/batch", BATCH);

    expect(response.status).toBe(202);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
    expect(await response.json()).toEqual({ seq: 1 });
    expect(one.lines[1]).toMatchObject({ type: "batch", seq: 1 });
    expect(one.lines[1]?.type === "batch" && one.lines[1].text).toContain("\n\n1. [Remove]\n");
    expect(await readdir(join(one.dir, "sessions/s1/pending"))).toEqual(["1.json"]);
  });

  test("a delivery forgets the pending batch", async () => {
    const one = await serve();
    await post(one, "api/batch", BATCH);

    expect((await post(one, "api/delivery", { seq: 1, outcome: "delivered" }, null)).status).toBe(
      204,
    );
    expect(await readdir(join(one.dir, "sessions/s1/pending"))).toEqual([]);
  });

  test("the outcomes say what became of each batch asked, in order", async () => {
    const one = await serve();
    await Promise.all([1, 2, 3].map(async () => await post(one, "api/batch", BATCH)));
    await post(one, "api/delivery", { seq: 1, outcome: "delivered" }, null);
    await post(one, "api/delivery", { seq: 3, outcome: "dropped", reason: "busy" }, null);
    const response = await outcomes(one, [3, 2, 1, 9]);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
    expect(await response.json()).toEqual([
      { seq: 3, outcome: "dropped", reason: "busy" },
      { seq: 2, outcome: "pending" },
      { seq: 1, outcome: "delivered" },
      { seq: 9, outcome: "unknown" },
    ]);
  });

  test("an outcome reported before the server started again is still told", async () => {
    const first = await serve();
    await post(first, "api/batch", BATCH);
    await post(first, "api/delivery", { seq: 1, outcome: "delivered" }, null);
    first.started.stop();
    const second = await serve(first.dir);

    expect(await (await outcomes(second, [1])).json()).toEqual([{ seq: 1, outcome: "delivered" }]);
  });

  test("the outcomes keep the last hundred batches reported", async () => {
    const one = await serve();

    for (let seq = 1; seq <= 101; seq += 1) {
      await post(one, "api/batch", BATCH);
      await post(one, "api/delivery", { seq, outcome: "delivered" }, null);
    }

    expect(await (await outcomes(one, [1, 2, 101])).json()).toEqual([
      { seq: 1, outcome: "unknown" },
      { seq: 2, outcome: "delivered" },
      { seq: 101, outcome: "delivered" },
    ]);
  });

  test("outcomes asked after nothing answer nothing", async () => {
    const one = await serve();

    expect(await (await outcomes(one, [])).json()).toEqual([]);
  });

  test("a server started again on the same session tells the pending batches again, and numbers on", async () => {
    const first = await serve();
    await post(first, "api/batch", BATCH);
    first.started.stop();
    const second = await serve(first.dir);

    expect(second.lines.slice(1)).toEqual([expect.objectContaining({ type: "batch", seq: 1 })]);
    expect(await (await post(second, "api/batch", BATCH)).json()).toEqual({ seq: 2 });
  });

  test("batches posted at once get consecutive numbers, a pending file and a line each, in order", async () => {
    const one = await serve();

    const answers = await Promise.all(
      Array.from({ length: 5 }, async () => await (await post(one, "api/batch", BATCH)).json()),
    );

    expect(answers).toHaveLength(5);
    expect(answers).toEqual(expect.arrayContaining([1, 2, 3, 4, 5].map((seq) => ({ seq }))));
    expect(one.lines.slice(1).map((line) => line.type === "batch" && line.seq)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect((await readdir(join(one.dir, "sessions/s1/pending"))).toSorted()).toEqual([
      "1.json",
      "2.json",
      "3.json",
      "4.json",
      "5.json",
    ]);
  });

  test("an unreadable registry entry is skipped, and left in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pinpoint-"));
    await mkdir(join(dir, "sessions"));
    await writeFile(join(dir, "sessions/other.json"), "");
    await writeFile(join(dir, "sessions/torn.json"), '{"version":1,"pid":');
    await serve(dir);

    expect(existsSync(join(dir, "sessions/other.json"))).toBe(true);
    expect(existsSync(join(dir, "sessions/torn.json"))).toBe(true);
  });

  test("an unreadable pending file is skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pinpoint-"));
    await mkdir(join(dir, "sessions/s1/pending"), { recursive: true });
    await writeFile(join(dir, "sessions/s1/pending/1.json"), JSON.stringify({ seq: 1, text: "a" }));
    await writeFile(join(dir, "sessions/s1/pending/2.json"), "");
    const one = await serve(dir);

    expect(one.lines.slice(1)).toEqual([{ type: "batch", seq: 1, text: "a" }]);
  });

  test("a kept port still free is bound again under the kept token", async () => {
    const first = await serve();
    const kept = { port: first.started.port, token: first.started.token };
    first.started.stop();
    const second = await serve(first.dir, kept);

    expect([second.started.port, second.started.token]).toEqual([kept.port, kept.token]);
  });

  test("a kept port taken meanwhile binds another one under a new token", async () => {
    const holder = await serve();
    const other = await serve(null, { port: holder.started.port, token: "kept" });

    expect(other.started.port).not.toBe(holder.started.port);
    expect(other.started.token).not.toBe("kept");
  });

  test("close removes the session's files and ends the process", async () => {
    const one = await serve();
    await post(one, "api/batch", BATCH);

    expect((await post(one, "api/close", {}, null)).status).toBe(204);
    await Bun.sleep(5);

    expect(existsSync(join(one.dir, "sessions/s1"))).toBe(false);
    expect(existsSync(join(one.dir, "sessions/s1.json"))).toBe(false);
    expect(one.closed()).toBe(true);
  });
});

describe("what the server refuses", () => {
  test("a wrong token: 404", async () => {
    const one = await serve();

    expect((await fetch(`http://127.0.0.1:${one.started.port}/t/nope/overlay.js`)).status).toBe(
      404,
    );
  });

  test("a page of another machine: 403", async () => {
    const one = await serve();

    expect((await post(one, "api/batch", BATCH, "https://evil.example")).status).toBe(403);
  });

  test("a body that is not a batch: 400", async () => {
    const one = await serve();

    expect((await post(one, "api/batch", { selections: [] })).status).toBe(400);
    expect((await post(one, "api/batch", { selections: [{ note: "x" }] })).status).toBe(400);
  });

  test("outcomes asked after what is not a batch number: 400", async () => {
    const one = await serve();

    expect((await outcomes(one, [1, "x"])).status).toBe(400);
    expect((await outcomes(one, ["-1"])).status).toBe(400);
  });

  test("the module's routes, asked by a page: 404", async () => {
    const one = await serve();

    expect((await post(one, "api/close", {})).status).toBe(404);
    expect((await post(one, "api/delivery", { seq: 1, outcome: "delivered" })).status).toBe(404);
  });

  test("a preflight from the app is answered for its origin", async () => {
    const one = await serve();

    const response = await fetch(url(one, "api/batch"), {
      method: "OPTIONS",
      headers: { origin: APP, "access-control-request-method": "POST" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
  });
});
