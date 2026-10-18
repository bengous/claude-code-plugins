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
  target: URL | null = null,
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
    target,
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

const PAGE = "<!doctype html><html><head><title>App</title></head><body><h1>App</h1></body></html>";

/** A WebSocket handshake the fake app took. */
type Handshake = {
  readonly path: string;
  readonly protocols: readonly string[];
  readonly cookie: string | null;
};

/** The fake app behind a server: where it listens, and what reached it. */
type App = {
  readonly url: URL;
  readonly asked: string[];
  readonly handshakes: Handshake[];
  readonly ends: number[];
};

const apps: Bun.Server<undefined>[] = [];

/**
 * A dev server's ways: its page, gzipped when the request accepts it; an echo of what is posted;
 * a redirect; a WebSocket that says hello, echoes, answers under the last subprotocol offered,
 * and ends as told.
 */
function app(): App {
  const asked: string[] = [];
  const handshakes: Handshake[] = [];
  const ends: number[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, self) => {
      const { pathname, search } = new URL(request.url);
      asked.push(`${request.method} ${pathname}${search}`);

      if (request.headers.get("upgrade") === "websocket") {
        const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
          .split(",")
          .map((protocol) => protocol.trim())
          .filter((protocol) => protocol !== "");

        handshakes.push({
          path: `${pathname}${search}`,
          protocols,
          cookie: request.headers.get("cookie"),
        });

        if (pathname === "/refused") return new Response("not here", { status: 403 });
        const chosen = protocols.at(-1);
        const headers = new Headers();

        if (chosen !== undefined) headers.set("sec-websocket-protocol", chosen);

        return self.upgrade(request, { headers })
          ? undefined
          : new Response("not upgraded", { status: 400 });
      }

      if (pathname === "/") {
        const gzip = request.headers.get("accept-encoding")?.includes("gzip") === true;
        const headers = new Headers({ "content-type": "text/html; charset=utf-8", etag: '"page"' });

        if (gzip) headers.set("content-encoding", "gzip");

        return new Response(gzip ? Bun.gzipSync(PAGE) : PAGE, { headers });
      }

      if (pathname === "/echo") {
        return new Response(await request.arrayBuffer(), {
          status: 201,
          headers: {
            "content-type": "application/octet-stream",
            "x-app": "kept",
            "x-host": request.headers.get("host") ?? "",
          },
        });
      }

      if (pathname === "/old") {
        return new Response(null, { status: 302, headers: { location: "/new" } });
      }

      return new Response("not in the app", { status: 404 });
    },
    websocket: {
      open: (socket) => {
        socket.send("hello");
      },
      message: (socket, message) => {
        if (message === "end") socket.close(4001, "done");
        else if (message === "end abruptly") socket.terminate();
        else socket.send(message);
      },
      close: (_socket, code) => {
        ends.push(code);
      },
    },
  });

  apps.push(server);

  return { url: new URL(`http://127.0.0.1:${server.port}`), asked, handshakes, ends };
}

/** A page's WebSocket to the server: whether it opened, each message in turn, how it ended. */
type Socket = {
  readonly socket: WebSocket;
  readonly opened: Promise<boolean>;
  readonly next: () => Promise<string | ArrayBuffer>;
  readonly ended: Promise<CloseEvent>;
};

function connect(one: Running, path: string, options: Bun.WebSocketOptions = {}): Socket {
  // @ts-expect-error -- Bun's client takes options, headers among them; the `DOM` lib types subprotocols only.
  const socket: WebSocket = new WebSocket(`ws://127.0.0.1:${one.started.port}${path}`, options);
  socket.binaryType = "arraybuffer";
  const heard: (string | ArrayBuffer)[] = [];
  const waiting: ((message: string | ArrayBuffer) => void)[] = [];

  socket.addEventListener("message", ({ data }) => {
    const message = data instanceof ArrayBuffer ? data : String(data);
    const waiter = waiting.shift();

    if (waiter === undefined) heard.push(message);
    else waiter(message);
  });

  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => resolve(true), { once: true });
    socket.addEventListener("close", () => resolve(false), { once: true });
  });

  const ended = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });

  const next = async (): Promise<string | ArrayBuffer> => {
    const message = heard.shift();

    return (
      message ??
      (await new Promise((resolve) => {
        waiting.push(resolve);
      }))
    );
  };

  return { socket, opened, next, ended };
}

/** What the server answers a request line written by hand, one no `fetch` sends. */
async function raw(one: Running, requestLine: string): Promise<string> {
  const reply = Promise.withResolvers<string>();
  let text = "";

  await Bun.connect({
    hostname: "127.0.0.1",
    port: one.started.port,
    socket: {
      open: (socket) => {
        socket.write(`${requestLine}\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n`);
      },
      data: (_socket, chunk) => {
        text += chunk.toString();
      },
      close: () => reply.resolve(text),
    },
  });

  return await reply.promise;
}

afterEach(async () => {
  for (const one of running.splice(0)) {
    one.started.stop();
    await rm(one.dir, { recursive: true, force: true });
  }

  for (const server of apps.splice(0)) await server.stop(true);
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

describe("a server with a target app", () => {
  test("a page of the app comes with the overlay's tag at the end of its body", async () => {
    const target = app();
    const one = await serve(null, null, target.url);

    const response = await fetch(`http://127.0.0.1:${one.started.port}/`, {
      headers: { "accept-encoding": "gzip, br" },
    });

    const tag = `<script src="/t/${one.started.token}/overlay.js" defer></script>`;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.text()).toBe(PAGE.replace("</body>", `${tag}</body>`));
  });

  test("any other answer passes as the app gave it, and the request's body goes on", async () => {
    const target = app();
    const one = await serve(null, null, target.url);

    const response = await fetch(`http://127.0.0.1:${one.started.port}/echo?x=1`, {
      method: "POST",
      body: new Uint8Array([0, 1, 2, 255]),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-app")).toBe("kept");
    expect(response.headers.get("x-host")).toBe(target.url.host);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(target.asked).toEqual(["POST /echo?x=1"]);
  });

  test("a redirect reaches the page as the app gave it, not followed", async () => {
    const target = app();
    const one = await serve(null, null, target.url);

    const response = await fetch(`http://127.0.0.1:${one.started.port}/old`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/new");
    expect(target.asked).toEqual(["GET /old"]);
  });

  test("a path that reads as another host still goes to the app", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const reply = await raw(one, "GET //evil.example/x HTTP/1.1");

    expect(reply).toStartWith("HTTP/1.1 404");
    expect(reply).toEndWith("not in the app");
    expect(target.asked).toEqual([expect.stringMatching(/^GET \/+evil\.example\/x$/u)]);
  });

  test("a WebSocket is relayed both ways, under the subprotocol the app chose", async () => {
    const target = app();
    const one = await serve(null, null, target.url);

    const page = connect(one, "/hmr?token=abc", {
      protocols: ["json", "vite-hmr"],
      headers: { cookie: "sid=1" },
    });

    expect(await page.opened).toBe(true);
    expect(page.socket.protocol).toBe("vite-hmr");
    expect(await page.next()).toBe("hello");
    page.socket.send("ping");
    expect(await page.next()).toBe("ping");
    page.socket.send(new Uint8Array([0, 255]));
    expect(await page.next()).toEqual(new Uint8Array([0, 255]).buffer);
    expect(target.handshakes).toEqual([
      { path: "/hmr?token=abc", protocols: ["json", "vite-hmr"], cookie: "sid=1" },
    ]);
  });

  test("the app's end reaches the page as it ended: its code and reason, or no closing handshake", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const clean = connect(one, "/hmr");
    const abrupt = connect(one, "/hmr");

    expect(await Promise.all([clean.opened, abrupt.opened])).toEqual([true, true]);
    clean.socket.send("end");
    abrupt.socket.send("end abruptly");
    const [cleanEnd, abruptEnd] = await Promise.all([clean.ended, abrupt.ended]);

    expect([cleanEnd.code, cleanEnd.reason, cleanEnd.wasClean]).toEqual([4001, "done", true]);
    expect(abruptEnd.wasClean).toBe(false);
  });

  test("a page that closes its WebSocket closes the app's", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const page = connect(one, "/hmr");

    expect(await page.opened).toBe(true);
    expect(target.ends).toEqual([]);
    page.socket.close();
    await page.ended;

    while (target.ends.length === 0) await Bun.sleep(5);

    expect(target.ends).toHaveLength(1);
  });

  test("a WebSocket the app refuses never opens for the page", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const page = connect(one, "/refused", { protocols: ["vite-ping"] });

    expect(await page.opened).toBe(false);
    expect(target.handshakes).toHaveLength(1);
  });

  test("the token's routes answer as before, and the app is never asked", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const overlay = await fetch(url(one, "overlay.js"));

    expect(overlay.status).toBe(200);
    expect(overlay.headers.get("content-type")).toContain("javascript");
    expect((await post(one, "api/batch", BATCH)).status).toBe(202);
    expect((await fetch(url(one, "nope"))).status).toBe(404);
    expect(target.asked).toEqual([]);
  });

  test("a page of another machine is refused before the app is asked: 403", async () => {
    const target = app();
    const one = await serve(null, null, target.url);

    const response = await fetch(`http://127.0.0.1:${one.started.port}/`, {
      headers: { origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
    expect(target.asked).toEqual([]);
  });

  test("an app that does not answer: 502, naming it", async () => {
    const gone = app();
    await apps.splice(0)[0]?.stop(true);
    const one = await serve(null, null, gone.url);
    const response = await fetch(`http://127.0.0.1:${one.started.port}/`);

    expect(response.status).toBe(502);
    expect(await response.text()).toContain(gone.url.origin);
  });
});

describe("a server without a target", () => {
  test("what lies outside the token's routes is not found, a WebSocket included", async () => {
    const one = await serve();

    expect((await fetch(`http://127.0.0.1:${one.started.port}/`)).status).toBe(404);
    expect(await connect(one, "/").opened).toBe(false);
  });
});
