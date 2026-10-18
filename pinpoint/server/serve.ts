import { addressOn, targetOf } from "../shared/target.ts";
import type { BatchAccepted, ImageAccepted, Outcome, ServerLine } from "../shared/wire.ts";
import { type Found, pickPage, probe } from "./apps.ts";
import { buildOverlay } from "./build.ts";
import { sessionFiles, sweepSessions } from "./files.ts";
import { parseBatchRequest, parseDelivery, parseSeqs, parseTargetRequest } from "./parse.ts";
import { forward, HOP, type Relay, relays } from "./proxy.ts";
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
  /** The directory of the Claude Code session, which the overlay's panel names. */
  readonly root: string;
  /** The last batch the module handed to the session, which every new batch's number passes. */
  readonly relayed: number;
  /**
   * How many days another session's files stay once nothing in them changes, Claude Code's
   * `cleanupPeriodDays`; `null` sweeps none.
   */
  readonly keepDays: number | null;
  /** `0` for any; a port taken meanwhile binds another one, under a new token. */
  readonly port: number;
  readonly token: string | undefined;
  /**
   * The app every request outside the token's routes goes to, its pages given the overlay; only
   * its origin counts. `null`, or the server's own address: `/` asks "Which app?" until one is
   * chosen, and every other request is not found.
   */
  readonly target: URL | null;
  /** The ports "Which app?" probes at `localhost`: `DEV_PORTS` outside the tests. */
  readonly ports: readonly number[];
  /** Hears `ready` once the server listens, then each batch and each app chosen, in order. */
  readonly announce: (line: ServerLine) => void;
  /** `POST api/close` once the session's directory is removed: the process ends. */
  readonly closed: () => void;
  /** `POST api/open`: the session's address for the browser, `null` once it is handed over, else why not; `openInBrowser` outside the tests. */
  readonly open: (address: string) => string | null;
  readonly watchdog: Watchdog;
};

export type Started = {
  readonly port: number;
  readonly token: string;
  /** Stops the server and its timers; for tests, which share one process. */
  readonly stop: () => void;
};

const LOOPBACK_NAME = String.raw`(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?`;

const LOOPBACK = new RegExp(String.raw`^https?:\/\/${LOOPBACK_NAME}$`, "u");

/** A page this server serves, at its own port: a browser sets `Origin`, which no page can forge. */
function isOwnPage(origin: string, port: number): boolean {
  return LOOPBACK.test(origin) && Number(URL.parse(origin)?.port) === port;
}

/**
 * A request to a name of this machine. A name rebound to 127.0.0.1 makes its page same-origin
 * with the server, so its GETs carry no `Origin`; only the `Host` they name tells them apart.
 */
const LOOPBACK_HOST = new RegExp(`^${LOOPBACK_NAME}$`, "u");

/** The names a request to this machine's loopback goes by, `0.0.0.0` and `*.localhost` included. */
const SELF_NAME = /^(?:(?:.+\.)?localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/u;

/** Whether `url` names this server, `port` being its own: forwarding there would loop back to it. */
function isOwn(url: URL, port: number): boolean {
  const at = url.port === "" ? 80 : Number(url.port);

  return url.protocol === "http:" && at === port && SELF_NAME.test(url.hostname);
}

/** What became of an address offered as the app: served from now on, or refused and why. */
type Choice = { readonly chosen: URL } | { readonly refused: string };

/** The largest image a page hands over; how large a zone's PNG gets is not measured. */
export const IMAGE_LIMIT = 20 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A probe of the dev ports is reused this long: each one asks every app for its `/`. */
const PROBE_FRESH_MS = 5_000;

/** Where the browser goes once `url` is served: its path on this server, never `//elsewhere`. */
function locationOf(url: URL): string {
  return `/${url.pathname.replace(/^\/+/u, "")}${url.search}`;
}

function isPortTaken(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EADDRINUSE";
}

type Bound = { readonly server: Bun.Server<Relay>; readonly token: string };

export async function startServer(options: ServeOptions): Promise<Started> {
  const files = sessionFiles(options.dir, options.session, options.relayed);
  const overlay = await buildOverlay(options.root);

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

  // Both set once the bind fixed the port: the check of an app that would be the server itself
  // needs it, and nothing is forwarded before.
  let own = 0;
  let target: URL | null = null;

  // Rides on every request the server forwards: one that comes back to it named the server under a
  // name `isOwn` does not know (`localhost.`, an IPv4-mapped address, a hosts file alias).
  const hop = crypto.randomUUID();
  let probed: { readonly at: number; readonly apps: Promise<Found[]> } | null = null;

  const appsFound = (maxAgeMs: number): Promise<Found[]> => {
    if (probed === null || Date.now() - probed.at >= maxAgeMs) {
      probed = { at: Date.now(), apps: probe(options.ports, own) };
    }

    return probed.apps;
  };

  const choose = (text: string): Choice => {
    const url = targetOf(text);

    if (url === null) return { refused: `"${text}" is not an http(s) address.` };

    if (isOwn(url, own)) {
      return { refused: `${url.origin} is this pinpoint server: name the app's own address.` };
    }

    target = url;
    options.announce({ type: "target", target: url.href });

    return { chosen: url };
  };

  // A refusal shows the apps the page it came from showed, whatever their age.
  const picker = async (
    token: string,
    error: string | null,
    typed: string,
    status: number,
  ): Promise<Response> =>
    new Response(
      pickPage(
        token,
        options.root,
        await appsFound(error === null ? PROBE_FRESH_MS : Infinity),
        error,
        typed,
      ),
      {
        status,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      },
    );

  const routes = async (
    path: string,
    request: Request,
    origin: string | null,
    token: string,
  ): Promise<Response> => {
    if (request.method === "GET" && path === "overlay.js") {
      return new Response(overlay, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (request.method === "GET" && path === "api/outcomes") {
      const seqs = parseSeqs(new URL(request.url).searchParams.getAll("seq"));

      if (seqs === null) return new Response("not batch numbers", { status: 400 });
      const outcomes: Outcome[] = await files.outcomes(seqs);

      return Response.json(outcomes, { headers: { "cache-control": "no-store" } });
    }

    if (request.method === "POST" && path === "api/batch") {
      const batch = parseBatchRequest(await request.json().catch(() => null));

      if (batch === null) return new Response("not a batch", { status: 400 });

      const seq = await inTurn(async () => {
        const next = await files.nextSeq();
        const text = batchText(next, batch.selections, files.imagePath);
        await files.keepPending({ seq: next, text });
        options.announce({ type: "batch", seq: next, text });

        return next;
      });

      const accepted: BatchAccepted = { seq };

      return Response.json(accepted, { status: 202 });
    }

    if (request.method === "POST" && path === "api/image") {
      // The length a page declares is checked first, so a large body is refused before it is
      // read; a body that declares none (chunked) is refused rather than read to find out.
      const declared = request.headers.get("content-length");

      if (declared === null) return new Response("pinpoint: length required", { status: 411 });

      const bytes =
        Number(declared) > IMAGE_LIMIT ? null : new Uint8Array(await request.arrayBuffer());

      if (bytes === null || bytes.length > IMAGE_LIMIT) {
        return new Response("pinpoint: image too large", { status: 413 });
      }

      if (request.headers.get("content-type") !== "image/png" || !isPng(bytes)) {
        return new Response("not a PNG", { status: 400 });
      }

      const accepted: ImageAccepted = { id: await files.keepImage(bytes) };

      return Response.json(accepted, { status: 201 });
    }

    // The "Which app?" form, its own page's alone and only while it asks: once an app is served,
    // the app's own scripts share this origin, and only the module switches it.
    if (request.method === "POST" && path === "pick") {
      if (origin === null) {
        return new Response("pinpoint: only its own page picks the app", { status: 403 });
      }

      if (target !== null) {
        return new Response(
          "pinpoint: an app is already served; /pinpoint:start <url> switches it",
          {
            status: 409,
          },
        );
      }

      const field = (await request.formData().catch(() => null))?.get("url") ?? null;
      const typed = field === null || field instanceof File ? "" : field;
      const choice = choose(typed);

      return "chosen" in choice
        ? new Response(null, { status: 303, headers: { location: locationOf(choice.chosen) } })
        : await picker(token, choice.refused, typed, 400);
    }

    // The module's own routes: it sends no `Origin`, and a page never has a reason to call them.
    if (origin !== null) return new Response("not found", { status: 404 });

    if (request.method === "POST" && path === "api/target") {
      const asked = parseTargetRequest(await request.json().catch(() => null));

      if (asked === null) return new Response("not a target", { status: 400 });
      const choice = choose(asked.url);

      return "chosen" in choice
        ? new Response(null, { status: 204 })
        : new Response(choice.refused, { status: 400 });
    }

    if (request.method === "POST" && path === "api/open") {
      const failed = options.open(addressOn(own, target));

      return failed === null
        ? new Response(null, { status: 204 })
        : new Response(failed, { status: 502 });
    }

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
        if (request.headers.get(HOP) === hop) {
          return new Response(
            "pinpoint: the app's address leads back to this server; run /pinpoint:start with the app's own address",
            { status: 508 },
          );
        }

        const host = request.headers.get("host") ?? "";

        if (!LOOPBACK_HOST.test(host)) {
          return new Response("pinpoint answers requests to this machine's names only", {
            status: 403,
          });
        }

        const origin = request.headers.get("origin");

        if (origin !== null && !LOOPBACK.test(origin)) {
          return new Response("pinpoint answers pages of this machine only", { status: 403 });
        }

        const { pathname } = new URL(request.url);
        const prefix = `/t/${token}/`;

        if (pathname.startsWith(prefix)) {
          // The overlay and "Which app?" are this server's own pages, never another origin's.
          if (origin !== null && !isOwnPage(origin, own)) {
            return new Response("pinpoint answers its own pages only", { status: 403 });
          }

          return await routes(pathname.slice(prefix.length), request, origin, token);
        }

        // Absolute, off the `Host` checked above: a page's `<base href>` would send a relative
        // `src` and the token to another host, and the overlay takes its server's address from it.
        if (target !== null) {
          const overlayUrl = `http://${host}${prefix}overlay.js`;

          return await forward(request, server, { target, host, overlay: overlayUrl, hop });
        }

        return request.method === "GET" && pathname === "/"
          ? await picker(token, null, "", 200)
          : new Response("not found", { status: 404 });
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
  own = port;
  target = options.target !== null && isOwn(options.target, port) ? null : options.target;

  options.announce({ type: "ready", port, token, target: target?.href ?? null });

  // A batch the last server took and no module handed to the session: told again, in order.
  for (const pending of await files.pending()) options.announce({ type: "batch", ...pending });
  told.resolve();

  const watchdog = setInterval(() => {
    if (Date.now() - lastHeartbeat > options.watchdog.graceMs) options.watchdog.expire();
  }, options.watchdog.periodMs);

  // After `ready`: the module waits for it, not for the sweep.
  if (options.keepDays !== null) {
    const failures = await sweepSessions(
      options.dir,
      options.session,
      options.keepDays * DAY_MS,
    ).catch((cause: unknown) => [String(cause)]);

    for (const failure of failures) console.error(`pinpoint: a session was not swept: ${failure}`);
  }

  return {
    port,
    token,
    stop: () => {
      clearInterval(watchdog);
      void bound.server.stop(true);
    },
  };
}
