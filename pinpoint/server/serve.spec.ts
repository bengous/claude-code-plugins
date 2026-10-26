import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  BatchRequest,
  Delivery,
  ImageAccepted,
  Selection,
  ServerLine,
  TargetRequest,
} from "../shared/wire.ts";
import { IMAGE_LIMIT, type Started, startServer } from "./serve.ts";

/** A page of another origin on this machine, as an app at its own address would be. */
const ELSEWHERE = "http://localhost:5173";

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
        url: "http://localhost:41237/",
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
  /** Each address the server asked the browser to open. */
  readonly opened: string[];
};

const running: Running[] = [];

/** What the module passes a server beside its address, as `cli.ts` takes it. */
type Given = { readonly relayed?: number; readonly keepDays?: number | null };

async function serve(
  dir: string | null = null,
  kept: { port: number; token: string } | null = null,
  target: URL | null = null,
  ports: readonly number[] = [],
  opener: string | null = null,
  given: Given = {},
): Promise<Running> {
  const home = dir ?? (await mkdtemp(join(tmpdir(), "pinpoint-")));
  const lines: ServerLine[] = [];
  const opened: string[] = [];
  let closed = false;

  const started = await startServer({
    dir: home,
    session: "s1",
    root: "/work/app",
    relayed: given.relayed ?? 0,
    keepDays: given.keepDays === undefined ? 30 : given.keepDays,
    port: kept?.port ?? 0,
    token: kept?.token,
    target,
    ports,
    announce: (line) => lines.push(line),
    closed: () => {
      closed = true;
    },
    open: (address) => {
      opened.push(address);

      return opener;
    },
    watchdog: { graceMs: 60_000, periodMs: 60_000, expire: () => {} },
  });

  const one = { started, lines, dir: home, closed: () => closed, opened };
  running.push(one);

  return one;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Writes another session's files under `dir`, then dates each by the days since it last changed,
 * as `files` names them; its directories take the oldest.
 */
async function session(
  dir: string,
  name: string,
  files: Readonly<Record<string, number>>,
): Promise<void> {
  const own = join(dir, "sessions", name);

  for (const file of Object.keys(files)) {
    await mkdir(dirname(join(own, file)), { recursive: true });
    await writeFile(join(own, file), "x");
  }

  const oldest = Math.max(...Object.values(files));

  for (const entry of ["", ...(await readdir(own, { recursive: true }))]) {
    const when = new Date(Date.now() - (files[entry] ?? oldest) * DAY_MS);
    await utimes(join(own, entry), when, when);
  }
}

function url(one: Running, path: string): string {
  return `http://127.0.0.1:${one.started.port}/t/${one.started.token}/${path}`;
}

/** What a test posts: a route's own body, one a parser must refuse, or none. */
type Posted =
  | BatchRequest
  | Delivery
  | TargetRequest
  | { readonly selections: readonly Partial<Selection>[] }
  | Readonly<Record<string, never>>;

/** The origin of the pages the server serves, the address the session prints. */
function ownOrigin(one: Running): string {
  return `http://localhost:${one.started.port}`;
}

/** Posts `body` as a page of the server does, or as the module does with `origin` null. */
function post(
  one: Running,
  path: string,
  body: Posted,
  origin: string | null = ownOrigin(one),
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });

  if (origin !== null) headers.set("origin", origin);

  return fetch(url(one, path), { method: "POST", headers, body: JSON.stringify(body) });
}

/** A PNG's signature, then a few bytes: what the server checks of an image. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Posts `bytes` as the overlay hands a zone's image over. */
function postImage(
  one: Running,
  bytes: Uint8Array<ArrayBuffer>,
  type = "image/png",
  origin: string = ownOrigin(one),
): Promise<Response> {
  return fetch(url(one, "api/image"), {
    method: "POST",
    headers: { "content-type": type, origin },
    body: new Blob([bytes]),
  });
}

/** `BATCH` with a zone whose image is `image`. */
function zoneBatch(image: { readonly id: string } | { readonly failed: string }): BatchRequest {
  const [selection] = BATCH.selections;

  if (selection === undefined) throw new Error("BATCH holds a selection");

  return {
    selections: [
      {
        ...selection,
        targets: [
          { kind: "zone", box: { x: 0, y: 0, width: 400, height: 90 }, elements: [], image },
        ],
      },
    ],
  };
}

/** Asks what became of `seqs`, as the overlay does: a same-origin GET carries no `Origin`. */
function outcomes(
  one: Running,
  seqs: readonly (number | string)[],
  origin: string | null = null,
): Promise<Response> {
  const query = seqs.map((seq) => `seq=${seq}`).join("&");
  const headers = new Headers();

  if (origin !== null) headers.set("origin", origin);

  return fetch(url(one, `api/outcomes?${query}`), { headers });
}

const PAGE = "<!doctype html><html><head><title>App</title></head><body><h1>App</h1></body></html>";

const SCRIPT = "console.log('app')";

type Handshake = {
  readonly path: string;
  readonly protocols: readonly string[];
  readonly host: string | null;
  readonly cookie: string | null;
};

type App = {
  readonly url: URL;
  readonly asked: string[];
  readonly handshakes: Handshake[];
  /** The code and reason of each page's end, as the app heard it. */
  readonly ends: (readonly [number, string])[];
  /** The paths of the requests whose page left before the app answered. */
  readonly cancelled: string[];
};

const apps: Bun.Server<undefined>[] = [];

/**
 * A dev server's ways: its page, gzipped when the request accepts it; a page and a script it
 * gzips whatever the request accepts; an echo of what is posted; a redirect; an answer after 13 s
 * of silence; one that never comes; a WebSocket that says hello, echoes, answers under the last
 * subprotocol offered, and ends as told.
 */
function app(): App {
  const asked: string[] = [];
  const handshakes: Handshake[] = [];
  const ends: (readonly [number, string])[] = [];
  const cancelled: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
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
          host: request.headers.get("host"),
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

        const headers = new Headers({
          "content-type": "text/html; charset=utf-8",
          etag: '"page"',
          "cache-control": "max-age=3600",
        });

        if (gzip) headers.set("content-encoding", "gzip");

        return new Response(gzip ? Bun.gzipSync(PAGE) : PAGE, { headers });
      }

      if (pathname === "/gzipped" || pathname === "/gzipped.js") {
        const page = pathname === "/gzipped";

        return new Response(Bun.gzipSync(page ? PAGE : SCRIPT), {
          headers: {
            "content-type": page ? "text/html" : "text/javascript",
            "content-encoding": "gzip",
          },
        });
      }

      if (pathname === "/slow") {
        await Bun.sleep(13_000);

        return new Response("at last");
      }

      if (pathname === "/never") {
        request.signal.addEventListener("abort", () => cancelled.push(pathname));

        return await new Promise<Response>(() => {});
      }

      if (pathname === "/echo") {
        return new Response(await request.arrayBuffer(), {
          status: 201,
          headers: {
            "content-type": "application/octet-stream",
            "x-app": "kept",
            "x-host": request.headers.get("host") ?? "",
            "x-origin": request.headers.get("origin") ?? "",
          },
        });
      }

      if (pathname === "/old") {
        return new Response(null, { status: 302, headers: { location: "/new" } });
      }

      if (pathname === "/login") {
        const own = `http://127.0.0.1:${self.port}`;

        return new Response(null, {
          status: 302,
          headers: { location: `${own}/dashboard?from=login#top` },
        });
      }

      if (pathname === "/away") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://accounts.example/oauth" },
        });
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
      close: (_socket, code, reason) => {
        ends.push([code, reason]);
      },
    },
  });

  apps.push(server);

  return { url: new URL(`http://127.0.0.1:${server.port}`), asked, handshakes, ends, cancelled };
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

/** A page's WebSocket that opens, then drops its connection with no closing handshake. */
async function dropped(one: Running, path: string): Promise<void> {
  const upgraded = Promise.withResolvers<void>();

  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: one.started.port,
    socket: {
      data: (_socket, chunk) => {
        if (chunk.toString().startsWith("HTTP/1.1 101")) upgraded.resolve();
      },
    },
  });

  socket.write(
    `GET ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\nupgrade: websocket\r\nconnection: Upgrade\r\n` +
      "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  await upgraded.promise;
  socket.end();
}

afterEach(async () => {
  for (const one of running.splice(0)) {
    one.started.stop();
    await rm(one.dir, { recursive: true, force: true });
  }

  for (const server of apps.splice(0)) await server.stop(true);
});

describe("the server", () => {
  test("announces ready, and writes nothing until a batch comes", async () => {
    const one = await serve();

    expect(one.lines[0]).toEqual({
      type: "ready",
      port: one.started.port,
      token: one.started.token,
      target: null,
    });
    expect(await readdir(one.dir)).toEqual([]);
  });

  test("serves the overlay as a script", async () => {
    const one = await serve();
    const response = await fetch(url(one, "overlay.js"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toContain("pinpoint-overlay");
  });

  test("a server started again on its port and token serves the same overlay", async () => {
    const first = await serve();
    const kept = { port: first.started.port, token: first.started.token };
    const before = await (await fetch(url(first, "overlay.js"))).text();
    first.started.stop();
    const second = await serve(first.dir, kept);

    expect(await (await fetch(url(second, "overlay.js"))).text()).toBe(before);
  });

  test("a batch is numbered, announced as the prompt's text, and kept until delivered", async () => {
    const one = await serve();
    const response = await post(one, "api/batch", BATCH);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ seq: 1 });
    expect(one.lines[1]).toMatchObject({ type: "batch", seq: 1 });
    expect(one.lines[1]?.type === "batch" && one.lines[1].text).toContain("\n\n1. [Remove]\n");
    expect(await readdir(join(one.dir, "sessions/s1/pending"))).toEqual(["1.json"]);
  });

  test("an image is kept under the id it answers, and a zone naming it prints where it is", async () => {
    const one = await serve();
    const response = await postImage(one, PNG);

    expect(response.status).toBe(201);
    // SAFETY: a 201 of this route carries an `ImageAccepted`.
    const { id } = (await response.json()) as ImageAccepted;
    const kept = join(one.dir, "sessions/s1/images", `${id}.png`);
    expect(new Uint8Array(await readFile(kept))).toEqual(PNG);

    await post(one, "api/batch", zoneBatch({ id }));
    expect(one.lines[1]?.type === "batch" && one.lines[1].text).toContain(`\n     image: ${kept}`);
  });

  test("a zone whose image the page could not take says why", async () => {
    const one = await serve();
    await post(one, "api/batch", zoneBatch({ failed: "the server does not answer" }));

    expect(one.lines[1]?.type === "batch" && one.lines[1].text).toContain(
      "\n     image: not taken (the server does not answer)",
    );
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
    const dir = await mkdtemp(join(tmpdir(), "pinpoint-"));
    await mkdir(join(dir, "sessions/s1"), { recursive: true });
    await writeFile(join(dir, "sessions/s1/seq"), "100\n");

    await writeFile(
      join(dir, "sessions/s1/settled.json"),
      JSON.stringify(
        Array.from({ length: 100 }, (_, at) => ({ seq: at + 1, outcome: "delivered" })),
      ),
    );

    const one = await serve(dir);
    expect(await (await post(one, "api/batch", BATCH)).json()).toEqual({ seq: 101 });
    await post(one, "api/delivery", { seq: 101, outcome: "delivered" }, null);

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

  test("a batch is numbered past the last the session took, its files gone before the start or since", async () => {
    const one = await serve(null, null, null, [], null, { relayed: 5 });

    expect(await (await post(one, "api/batch", BATCH)).json()).toEqual({ seq: 6 });
    await rm(join(one.dir, "sessions"), { recursive: true });
    expect(await (await post(one, "api/batch", BATCH)).json()).toEqual({ seq: 7 });
  });

  test("a batch is numbered past each batch told again at the start, the files gone since", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pinpoint-"));
    await mkdir(join(dir, "sessions/s1/pending"), { recursive: true });
    await writeFile(join(dir, "sessions/s1/seq"), "6\n");

    for (const seq of [5, 6]) {
      await writeFile(
        join(dir, `sessions/s1/pending/${seq}.json`),
        JSON.stringify({ seq, text: "" }),
      );
    }

    const one = await serve(dir, null, null, [], null, { relayed: 4 });
    await rm(join(dir, "sessions"), { recursive: true });

    expect(await (await post(one, "api/batch", BATCH)).json()).toEqual({ seq: 7 });
  });

  test("a seq that does not read refuses the batch rather than number it again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pinpoint-"));
    await mkdir(join(dir, "sessions/s1"), { recursive: true });
    await writeFile(join(dir, "sessions/s1/seq"), "6\n");
    await chmod(join(dir, "sessions/s1/seq"), 0o000);
    const one = await serve(dir);

    expect((await post(one, "api/batch", BATCH)).status).toBe(500);
    expect(one.lines.filter((line) => line.type === "batch")).toEqual([]);
  });

  test("a server keeps its session out of the sweep while it lives: its start and each heartbeat date it now", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pinpoint-"));
    await session(dir, "s1", { seq: 40 });
    const own = join(dir, "sessions/s1");
    const fresh = async () => Date.now() - (await stat(own)).mtimeMs < DAY_MS;
    const one = await serve(dir);

    expect(await fresh()).toBe(true);
    await session(dir, "s1", { seq: 40 });
    expect(await fresh()).toBe(false);
    await fetch(url(one, "api/heartbeat"), { method: "POST" });
    expect(await fresh()).toBe(true);
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

  test("a start removes each other session nothing changed in for longer than the period, and keeps the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pinpoint-"));
    await session(dir, "old", { seq: 31, "settled.json": 31, "images/a.png": 31 });
    await session(dir, "recent", { seq: 40, "images/b.png": 1 });
    await session(dir, "s1", { seq: 40 });
    await serve(dir);

    expect((await readdir(join(dir, "sessions"))).toSorted()).toEqual(["recent", "s1"]);
  });

  test("a start given no period removes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pinpoint-"));
    await session(dir, "old", { seq: 31 });
    await serve(dir, null, null, [], null, { keepDays: null });

    expect(await readdir(join(dir, "sessions"))).toEqual(["old"]);
  });

  test("close removes the session's files and ends the process", async () => {
    const one = await serve();
    await post(one, "api/batch", BATCH);

    expect((await post(one, "api/close", {}, null)).status).toBe(204);
    await Bun.sleep(5);

    expect(existsSync(join(one.dir, "sessions/s1"))).toBe(false);
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

  test("a request to a name other than this machine's, a name rebound to it: 403", async () => {
    const one = await serve();
    const asked = (host: string) => fetch(url(one, "overlay.js"), { headers: { host } });

    expect((await asked(`evil.example:${one.started.port}`)).status).toBe(403);
    expect((await asked("127.0.0.1.evil.example")).status).toBe(403);

    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect((await asked(`${host}:${one.started.port}`)).status).toBe(200);
    }
  });

  test("a body that is not a batch: 400", async () => {
    const one = await serve();

    expect((await post(one, "api/batch", { selections: [] })).status).toBe(400);
    expect((await post(one, "api/batch", { selections: [{ note: "x" }] })).status).toBe(400);
  });

  test("a zone whose image id is not one the server gives: 400", async () => {
    const one = await serve();

    expect((await post(one, "api/batch", zoneBatch({ id: "../../seq" }))).status).toBe(400);
  });

  test("an image that is not a PNG, or past the limit: refused, nothing kept", async () => {
    const one = await serve();
    const tooLarge = new Uint8Array(IMAGE_LIMIT + 1);
    tooLarge.set(PNG);

    expect((await postImage(one, new Uint8Array([1, 2, 3]))).status).toBe(400);
    expect((await postImage(one, PNG, "image/jpeg")).status).toBe(400);
    expect((await postImage(one, tooLarge)).status).toBe(413);
    expect((await postImage(one, PNG, "image/png", ELSEWHERE)).status).toBe(403);
    expect(existsSync(join(one.dir, "sessions/s1/images"))).toBe(false);
  });

  test("an image whose body declares no length: 411, nothing read", async () => {
    const one = await serve();

    const chunked = await fetch(url(one, "api/image"), {
      method: "POST",
      headers: { "content-type": "image/png", origin: ownOrigin(one) },
      body: new ReadableStream({
        start: (controller) => {
          controller.enqueue(PNG);
          controller.close();
        },
      }),
    });

    expect(chunked.status).toBe(411);
    expect(existsSync(join(one.dir, "sessions/s1/images"))).toBe(false);
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

  test("a page of another origin on this machine, the token in hand: 403, preflight included", async () => {
    const one = await serve();

    const preflight = await fetch(url(one, "api/batch"), {
      method: "OPTIONS",
      headers: { origin: ELSEWHERE, "access-control-request-method": "POST" },
    });

    expect((await outcomes(one, [1], ELSEWHERE)).status).toBe(403);
    expect((await post(one, "api/batch", BATCH, ELSEWHERE)).status).toBe(403);
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(one.lines.filter((line) => line.type === "batch")).toEqual([]);
  });

  test("its own pages are answered under every name of this machine", async () => {
    const one = await serve();

    for (const name of ["localhost", "127.0.0.1", "[::1]"]) {
      const origin = `http://${name}:${one.started.port}`;

      expect((await outcomes(one, [1], origin)).status).toBe(200);
    }
  });
});

describe("a server with a target app", () => {
  test("a page of the app comes with the overlay's tag, absolute on the Host asked, at the end of its body", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const host = `localhost:${one.started.port}`;

    const response = await fetch(`http://127.0.0.1:${one.started.port}/`, {
      headers: { host, "accept-encoding": "gzip, br" },
    });

    const tag = `<script src="http://${host}/t/${one.started.token}/overlay.js" defer></script>`;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(PAGE.replace("</body>", `${tag}</body>`));
  });

  test("an app that compresses anyway: its page still gets the tag, its script its bytes", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const base = `http://127.0.0.1:${one.started.port}`;
    const headers = { "accept-encoding": "gzip" };
    const page = await fetch(`${base}/gzipped`, { headers });
    const script = await fetch(`${base}/gzipped.js`, { headers });

    expect(page.headers.get("content-encoding")).toBeNull();
    expect(await page.text()).toContain(`/t/${one.started.token}/overlay.js`);
    expect(script.headers.get("content-encoding")).toBeNull();
    expect(await script.text()).toBe(SCRIPT);
  });

  test("a HEAD on a page passes as the app gave it", async () => {
    const target = app();
    const one = await serve(null, null, target.url);

    const direct = await fetch(`${target.url.origin}/`, {
      method: "HEAD",
      headers: { "accept-encoding": "identity" },
    });

    const proxied = await fetch(`http://127.0.0.1:${one.started.port}/`, { method: "HEAD" });

    expect(proxied.status).toBe(200);
    expect(proxied.headers.get("content-length")).toBe(direct.headers.get("content-length"));
    expect(proxied.headers.get("etag")).toBe('"page"');
  });

  test(
    "an app silent for longer than Bun's idle bound still answers",
    async () => {
      const target = app();
      const one = await serve(null, null, target.url);
      const response = await fetch(`http://127.0.0.1:${one.started.port}/slow`);

      expect(await response.text()).toBe("at last");
    },
    { timeout: 20_000 },
  );

  test("a page that leaves cancels the app's request", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const leaving = new AbortController();
    const asked = fetch(`http://127.0.0.1:${one.started.port}/never`, { signal: leaving.signal });

    while (target.asked.length === 0) await Bun.sleep(5);
    leaving.abort();
    await asked.catch(() => null);

    while (target.cancelled.length === 0) await Bun.sleep(5);

    expect(target.cancelled).toEqual(["/never"]);
  });

  test("the environment's HTTP proxy is not asked for the app", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    process.env.HTTP_PROXY = "http://127.0.0.1:9";

    try {
      const response = await fetch(`http://127.0.0.1:${one.started.port}/echo`, {
        method: "POST",
        body: "x",
        proxy: false,
      });

      expect(response.status).toBe(201);
    } finally {
      delete process.env.HTTP_PROXY;
    }
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
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(target.asked).toEqual(["POST /echo?x=1"]);
  });

  test("the app sees the Host the page asked, in step with its Origin", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const page = `localhost:${one.started.port}`;

    const response = await fetch(`http://127.0.0.1:${one.started.port}/echo`, {
      method: "POST",
      headers: { host: page, origin: `http://${page}` },
      body: "x",
    });

    expect(response.headers.get("x-host")).toBe(page);
    expect(response.headers.get("x-origin")).toBe(`http://${page}`);
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

  test("a redirect to the app's own origin comes back to the Host asked; one elsewhere goes as it came", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const host = `localhost:${one.started.port}`;

    const asked = (path: string) =>
      fetch(`http://127.0.0.1:${one.started.port}${path}`, {
        headers: { host },
        redirect: "manual",
      });

    expect((await asked("/login")).headers.get("location")).toBe(
      `http://${host}/dashboard?from=login#top`,
    );
    expect((await asked("/away")).headers.get("location")).toBe("https://accounts.example/oauth");
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
      {
        path: "/hmr?token=abc",
        protocols: ["json", "vite-hmr"],
        host: `127.0.0.1:${one.started.port}`,
        cookie: "sid=1",
      },
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

  test("the page's end reaches the app as it ended: its code and reason, or no closing handshake", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const page = connect(one, "/hmr");

    expect(await page.opened).toBe(true);
    expect(target.ends).toEqual([]);
    page.socket.close(4002, "bye");
    await page.ended;

    while (target.ends.length === 0) await Bun.sleep(5);
    await dropped(one, "/hmr");

    while (target.ends.length < 2) await Bun.sleep(5);

    expect(target.ends).toEqual([
      [4002, "bye"],
      [1006, ""],
    ]);
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

  test("a request to a name other than this machine's is refused before the app is asked: 403", async () => {
    const target = app();
    const one = await serve(null, null, target.url);
    const rebound = { host: `evil.example:${one.started.port}` };

    for (const path of ["/", "/echo"]) {
      const response = await fetch(`http://127.0.0.1:${one.started.port}${path}`, {
        headers: rebound,
      });

      expect(response.status).toBe(403);
    }

    expect(await connect(one, "/hmr", { headers: rebound }).opened).toBe(false);
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

/** Posts the "Which app?" form, as the page's own button or field does. */
function pick(one: Running, typed: string): Promise<Response> {
  return fetch(url(one, "pick"), {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${one.started.port}` },
    body: new URLSearchParams({ url: typed }),
    redirect: "manual",
  });
}

/** Sets the app as the module does, with no `Origin`, or as a page would. */
function retarget(one: Running, address: string, origin: string | null = null): Promise<Response> {
  return post(one, "api/target", { url: address }, origin);
}

function site(one: Running): string {
  return `http://127.0.0.1:${one.started.port}/`;
}

describe("a server with no app chosen", () => {
  test("asks which app at /, naming the session, listing each app found by its title and address", async () => {
    const target = app();
    const one = await serve(null, null, null, [target.url.port].map(Number));
    const response = await fetch(site(one));
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page).toContain("<h1>Which app?</h1>");
    expect(page).toContain("session in <strong>app</strong>");
    expect(page).toContain(`<span class="name">App</span>`);
    expect(page).toContain(`<span class="address">http://localhost:${target.url.port}/</span>`);
    expect(page).toContain(`action="/t/${one.started.token}/pick"`);
  });

  test("anything but / is not found, a WebSocket included", async () => {
    const one = await serve();

    expect((await fetch(`${site(one)}main.js`)).status).toBe(404);
    expect(await connect(one, "/").opened).toBe(false);
  });

  test("a click on an app makes the address serve it, with the overlay", async () => {
    const target = app();
    const one = await serve();
    const address = `http://localhost:${target.url.port}/`;
    const chosen = await pick(one, address);

    expect(chosen.status).toBe(303);
    expect(chosen.headers.get("location")).toBe("/");
    expect(one.lines.at(-1)).toEqual({ type: "target", target: address });
    expect(await (await fetch(site(one))).text()).toContain(`/t/${one.started.token}/overlay.js`);
  });

  test("the field takes an address with no scheme, and opens it at its path", async () => {
    const target = app();
    const one = await serve();
    const chosen = await pick(one, `localhost:${target.url.port}/echo?x=1`);

    expect(chosen.headers.get("location")).toBe("/echo?x=1");
    expect((await fetch(`${site(one)}echo?x=1`)).status).toBe(201);
  });

  test("the server's own address is refused, the page saying why", async () => {
    const one = await serve();
    const own = `http://localhost:${one.started.port}/`;
    const refused = await pick(one, own);
    const page = await refused.text();

    expect(refused.status).toBe(400);
    expect(page).toContain(`http://localhost:${one.started.port} is this pinpoint server`);
    expect(page).toContain(`value="${own}"`);
    expect(one.lines.filter((line) => line.type === "target")).toEqual([]);
    expect(await (await fetch(site(one))).text()).toContain("Which app?");
  });

  test("what is not an http(s) address is refused, the page keeping what was typed", async () => {
    const one = await serve();
    const refused = await pick(one, "ftp://files.example/");

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('value="ftp://files.example/"');
  });

  test("a path that reads as another host opens on this server, never off it", async () => {
    const target = app();
    const one = await serve();
    const chosen = await pick(one, `http://localhost:${target.url.port}//evil.example/x`);

    expect(chosen.headers.get("location")).toBe("/evil.example/x");
  });

  test("two pages a few seconds apart and a refusal probe the apps once", async () => {
    const target = app();
    const one = await serve(null, null, null, [Number(target.url.port)]);
    await fetch(site(one));
    await fetch(site(one));
    const refused = await pick(one, "ftp://files.example/");

    expect(await refused.text()).toContain(`http://localhost:${target.url.port}/`);
    expect(target.asked).toEqual(["GET /"]);
  });

  test("only its own page picks: a page of another origin cannot", async () => {
    const target = app();
    const one = await serve();

    const response = await fetch(url(one, "pick"), {
      method: "POST",
      headers: { origin: ELSEWHERE },
      body: new URLSearchParams({ url: target.url.href }),
      redirect: "manual",
    });

    expect(response.status).toBe(403);
    expect(one.lines.filter((line) => line.type === "target")).toEqual([]);
  });

  test("a --target that is the server's own address is refused once bound", async () => {
    const first = await serve();
    const kept = { port: first.started.port, token: first.started.token };
    first.started.stop();
    const second = await serve(first.dir, kept, new URL(`http://127.0.0.1:${kept.port}/`));

    expect(second.lines[0]).toEqual({ type: "ready", ...kept, target: null });
    expect(await (await fetch(site(second))).text()).toContain("Which app?");
  });
});

describe("switching the app", () => {
  test("the module's switch serves the other app at the same address", async () => {
    const before = app();
    const after = app();
    const one = await serve(null, null, before.url);

    expect(one.lines[0]).toMatchObject({ target: before.url.href });
    expect((await retarget(one, after.url.href)).status).toBe(204);
    expect(one.lines.at(-1)).toEqual({ type: "target", target: after.url.href });
    expect((await fetch(`${site(one)}old`, { redirect: "manual" })).status).toBe(302);
    expect(before.asked).toEqual([]);
    expect(after.asked).toEqual(["GET /old"]);
  });

  test("a switch to the server's own address is refused, the app kept", async () => {
    const before = app();
    const one = await serve(null, null, before.url);
    const refused = await retarget(one, `http://localhost:${one.started.port}/`);

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("is this pinpoint server");
    await fetch(`${site(one)}old`, { redirect: "manual" });

    expect(before.asked).toEqual(["GET /old"]);
  });

  test("a page cannot switch the app: the route is the module's", async () => {
    const before = app();
    const one = await serve(null, null, before.url);

    expect((await retarget(one, "http://localhost:1/", ownOrigin(one))).status).toBe(404);
  });

  test("once an app is served, its pages cannot pick another, even from this origin", async () => {
    const before = app();
    const one = await serve(null, null, before.url);
    const refused = await pick(one, "https://evil.example/");

    expect(refused.status).toBe(409);
    expect(one.lines.filter((line) => line.type === "target")).toEqual([]);
    await fetch(`${site(one)}old`, { redirect: "manual" });

    expect(before.asked).toEqual(["GET /old"]);
  });

  test.each(["localhost.", "[::ffff:127.0.0.1]"])(
    "an app address that is this server under the name %p ends at the first hop: 508",
    async (name) => {
      const one = await serve();

      expect((await retarget(one, `http://${name}:${one.started.port}/`)).status).toBe(204);
      const looped = await fetch(site(one), { signal: AbortSignal.timeout(2_000) });

      expect(looped.status).toBe(508);
      expect(await looped.text()).toContain("leads back to this server");
    },
  );
});

describe("the browser", () => {
  test("the module's open names the session's address: \"Which app?\", or the app's path once one is served", async () => {
    const asking = await serve();
    const serving = await serve(null, null, new URL("http://localhost:5999/admin?tab=1#top"));

    expect((await fetch(url(asking, "api/open"), { method: "POST" })).status).toBe(204);
    expect((await fetch(url(serving, "api/open"), { method: "POST" })).status).toBe(204);
    expect(asking.opened).toEqual([`http://localhost:${asking.started.port}/`]);
    expect(serving.opened).toEqual([`http://localhost:${serving.started.port}/admin?tab=1`]);
  });

  test("an opener that does not run answers 502, saying why", async () => {
    const one = await serve(null, null, null, [], "could not run xdg-open: Executable not found");
    const asked = await fetch(url(one, "api/open"), { method: "POST" });

    expect(asked.status).toBe(502);
    expect(await asked.text()).toBe("could not run xdg-open: Executable not found");
  });

  test("a page cannot open it: the route is the module's", async () => {
    const one = await serve();

    const asked = await fetch(url(one, "api/open"), {
      method: "POST",
      headers: { origin: ownOrigin(one) },
    });

    expect(asked.status).toBe(404);
    expect(one.opened).toEqual([]);
  });
});
