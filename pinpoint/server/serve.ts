import type { BatchAccepted, Outcome, ServerLine } from "../shared/wire.ts";
import { buildOverlay, writeViteModule } from "./build.ts";
import { pruneEntries, sessionFiles } from "./files.ts";
import { parseBatchRequest, parseDelivery, parseSeqs } from "./parse.ts";
import { forward, type Relay, relays } from "./proxy.ts";
import { batchText } from "./text.ts";

/** When the server gives up: `expire` runs once no heartbeat came for `graceMs`. */
export type Watchdog = {
  readonly graceMs: number;
  readonly periodMs: number;
  readonly expire: () => void;
};

export type ServeOptions = {
  /** Where the server's files live: `~/.claude/pinpoint` outside the tests. */
  readonly dir: string;
  readonly session: string;
  /** The directory of the Claude Code session, which the registry entry names. */
  readonly root: string;
  /** `0` for any; a port taken meanwhile binds another one, under a new token. */
  readonly port: number;
  readonly token: string | undefined;
  /**
   * The app every request outside the token's routes goes to, its pages given the overlay; only
   * its origin counts. `null`: those requests are not found.
   */
  readonly target: URL | null;
  /** Hears `ready` once the server listens, then each batch, in order. */
  readonly announce: (line: ServerLine) => void;
  /** `POST api/close` once the session's directory is removed: the process ends. */
  readonly closed: () => void;
  readonly watchdog: Watchdog;
};

export type Started = {
  readonly port: number;
  readonly token: string;
  /** Stops the server and its timers; for tests, which share one process. */
  readonly stop: () => void;
};

/** A page of the user's own machine: a browser sets `Origin`, which no page can forge. */
const LOOPBACK = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u;

function isPortTaken(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EADDRINUSE";
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin === null
    ? {}
    : {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
        "access-control-allow-private-network": "true",
        vary: "Origin",
      };
}

type Bound = { readonly server: Bun.Server<Relay>; readonly token: string };

export async function startServer(options: ServeOptions): Promise<Started> {
  const files = sessionFiles(options.dir, options.session);
  await pruneEntries(options.dir);
  const [overlay] = await Promise.all([buildOverlay(), writeViteModule(options.dir)]);

  // The session's files change one step at a time, each batch numbered, kept and announced
  // whole: the module hands batches over in the order of their lines, and only acknowledges a
  // number at or below the last it handed over. The queue opens once `ready` and the batches the
  // last server left are told, which the module reads first.
  const told = Promise.withResolvers<void>();
  let queue: Promise<unknown> = told.promise;

  const inTurn = <T>(step: () => Promise<T>): Promise<T> => {
    const turn = queue.then(step);
    queue = Promise.allSettled([turn]);

    return turn;
  };

  let lastHeartbeat = Date.now();

  const routes = async (
    path: string,
    request: Request,
    origin: string | null,
  ): Promise<Response> => {
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (request.method === "GET" && path === "overlay.js") {
      return new Response(overlay, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (request.method === "GET" && path === "api/outcomes") {
      const seqs = parseSeqs(new URL(request.url).searchParams.getAll("seq"));

      if (seqs === null) return new Response("not batch numbers", { status: 400, headers: cors });
      const outcomes: Outcome[] = await files.outcomes(seqs);

      return Response.json(outcomes, { headers: { ...cors, "cache-control": "no-store" } });
    }

    if (request.method === "POST" && path === "api/batch") {
      const batch = parseBatchRequest(await request.json().catch(() => null));

      if (batch === null) return new Response("not a batch", { status: 400, headers: cors });

      const seq = await inTurn(async () => {
        const next = await files.nextSeq();
        const text = batchText(next, batch.selections);
        await files.keepPending({ seq: next, text });
        options.announce({ type: "batch", seq: next, text });

        return next;
      });

      const accepted: BatchAccepted = { seq };

      return Response.json(accepted, { status: 202, headers: cors });
    }

    // The module's own routes: it sends no `Origin`, and a page never has a reason to call them.
    if (origin !== null) return new Response("not found", { status: 404, headers: cors });

    if (request.method === "POST" && path === "api/delivery") {
      const delivery = parseDelivery(await request.json().catch(() => null));

      if (delivery === null) return new Response("not a delivery", { status: 400 });
      await inTurn(() => files.settle(delivery));

      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && path === "api/heartbeat") {
      lastHeartbeat = Date.now();

      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && path === "api/close") {
      await files.removeAll();
      setTimeout(options.closed, 0);

      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  };

  const bind = (port: number, token: string): Bun.Server<Relay> =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      // Bun sets SO_REUSEPORT by default with `development: false`: a second server, of this
      // process or another, would share a kept port instead of failing over to a new one.
      reusePort: false,
      development: false,
      fetch: async (request, server) => {
        const origin = request.headers.get("origin");

        if (origin !== null && !LOOPBACK.test(origin)) {
          return new Response("pinpoint answers pages of this machine only", { status: 403 });
        }

        const { pathname } = new URL(request.url);
        const prefix = `/t/${token}/`;

        if (pathname.startsWith(prefix)) {
          return await routes(pathname.slice(prefix.length), request, origin);
        }

        return options.target === null
          ? new Response("not found", { status: 404 })
          : await forward(request, server, options.target, `${prefix}overlay.js`);
      },
      websocket: relays,
      error: (cause) => {
        console.error(`pinpoint: a request failed: ${cause.message}`);

        return new Response(cause.message, { status: 500 });
      },
    });

  const bound = ((): Bound => {
    const token = options.token ?? crypto.randomUUID();

    try {
      return { server: bind(options.port, token), token };
    } catch (cause) {
      if (!isPortTaken(cause)) throw cause;

      // The overlay's URL carries the token, so whoever took the port would read it from every
      // page that loads again: the kept token goes with the kept port.
      const fresh = crypto.randomUUID();

      return { server: bind(0, fresh), token: fresh };
    }
  })();

  const port = Number(bound.server.port);
  const { token } = bound;

  await files.writeEntry({
    version: 1,
    session: options.session,
    root: options.root,
    port,
    token,
    pid: process.pid,
    started: Date.now(),
  });

  options.announce({ type: "ready", port, token });

  // A batch the last server took and no module handed to the session: told again, in order.
  for (const pending of await files.pending()) options.announce({ type: "batch", ...pending });
  told.resolve();

  const watchdog = setInterval(() => {
    if (Date.now() - lastHeartbeat > options.watchdog.graceMs) options.watchdog.expire();
  }, options.watchdog.periodMs);

  return {
    port,
    token,
    stop: () => {
      clearInterval(watchdog);
      void bound.server.stop(true);
    },
  };
}
