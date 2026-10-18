/**
 * The target app, served through the session's server: its pages come with the overlay, every
 * other answer passes as the app gave it, and its WebSockets (Vite's hot reload among them) are
 * relayed both ways. Requests only ever go to the target's origin.
 */

type Page = Bun.ServerWebSocket<Relay>;

/** Bun's client, events typed by the `DOM` lib, whose `MessageEvent` `Bun.WebSocket` mistypes. */
type AppSocket = WebSocket & Pick<Bun.WebSocket, "terminate">;

/** A page's WebSocket: the app's side, open before the page's, and what the page hears once it opens. */
export type Relay = {
  readonly app: AppSocket;
  readonly opened: (page: Page) => void;
};

/** What the WebSocket client writes itself: the page's copies would break the app's handshake. */
const HANDSHAKE = [
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
];

/** The encodings Bun's `fetch` decodes by itself, while it keeps their `content-encoding` and length. */
const DECODED = new Set(["gzip", "deflate", "br", "zstd"]);

/** The request's path and query on the target, set apart so a path such as `//elsewhere/` stays a path. */
function atTarget(requestUrl: string, target: URL): URL {
  const { pathname, search } = new URL(requestUrl);
  const url = new URL(target.origin);
  url.pathname = pathname;
  url.search = search;

  return url;
}

/** A close code Bun's client accepts (RFC 6455); it throws on any other. */
function sendable(code: number): boolean {
  return (
    (code >= 1000 && code <= 1014 && (code < 1004 || code > 1006)) || (code >= 3000 && code <= 4999)
  );
}

/** The answer as Bun read it: a body it decoded no longer carries the app's encoding nor its length. */
function asRead(answer: Response): Response {
  if (!DECODED.has(answer.headers.get("content-encoding") ?? "")) return answer;
  const headers = new Headers(answer.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");

  return new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers,
  });
}

function withOverlay(page: Response, overlay: string): Response {
  const headers = new Headers(page.headers);
  // The page is not the app's: kept or revalidated, it would come back from the browser's cache
  // with the tag it was stored with, the token of an earlier server.
  headers.delete("etag");
  headers.delete("last-modified");
  headers.set("cache-control", "no-store");

  const rewriter = new HTMLRewriter().on("body", {
    element: (body) => {
      body.append(`<script src="${overlay}" defer></script>`, { html: true });
    },
  });

  return rewriter.transform(
    new Response(page.body, { status: page.status, statusText: page.statusText, headers }),
  );
}

async function relay(
  request: Request,
  server: Bun.Server<Relay>,
  url: URL,
  headers: Headers,
): Promise<Response | undefined> {
  for (const name of HANDSHAKE) headers.delete(name);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== "");

  const options: Bun.WebSocketOptions = { protocols, headers: Object.fromEntries(headers) };
  // @ts-expect-error -- Bun's client takes options and has `terminate`; the `DOM` lib types neither.
  const app: AppSocket = new WebSocket(url, options);
  let page: Page | null = null;
  const early: ((open: Page) => void)[] = [];

  const toPage = (act: (open: Page) => void): void => {
    if (page === null) early.push(act);
    else act(page);
  };

  app.addEventListener("message", ({ data }) => toPage((open) => open.send(data)));

  // An end without a closing handshake stays one: Vite's client polls for its restarted server
  // only after such an end, and reloads the page once it answers.
  app.addEventListener("close", ({ code, reason, wasClean }) =>
    toPage((open) => {
      if (!wasClean) open.terminate();
      else if (code === 1005) open.close();
      else open.close(code, reason);
    }),
  );

  // The page's side opens only once the app's has, under the subprotocol the app chose: a
  // handshake the app refuses is refused to the page, as Vite's ping for its server expects.
  const answered = await new Promise<boolean>((resolve) => {
    app.addEventListener("open", () => resolve(true), { once: true });
    app.addEventListener("close", () => resolve(false), { once: true });
  });

  if (!answered) {
    return new Response(`pinpoint: the app at ${url.origin} refused the WebSocket`, {
      status: 502,
    });
  }

  // A `Headers`, never a literal: Bun's `upgrade` throws on an empty `{}`.
  const accepted = new Headers();

  if (app.protocol !== "") accepted.set("sec-websocket-protocol", app.protocol);

  const opened = (open: Page): void => {
    page = open;

    for (const act of early.splice(0)) act(open);
  };

  if (server.upgrade(request, { data: { app, opened }, headers: accepted })) return undefined;
  app.close();

  return new Response("pinpoint: not a WebSocket handshake", { status: 400 });
}

export const relays: Bun.WebSocketHandler<Relay> = {
  open: (page) => {
    page.data.opened(page);
  },
  message: (page, message) => {
    page.data.app.send(message);
  },
  // 1006: the page's connection dropped without a closing handshake, which the app hears as such.
  close: (page, code, reason) => {
    const { app } = page.data;

    if (code === 1006) app.terminate();
    else if (sendable(code)) app.close(code, reason);
    else app.close();
  },
};

/**
 * Sends `request` on to `target`. A page comes back with `<script src="<overlay>" defer>` at the
 * end of its body; every other answer, a redirect and a HEAD included, passes as the app gave it.
 */
export async function forward(
  request: Request,
  server: Bun.Server<Relay>,
  target: URL,
  overlay: string,
): Promise<Response | undefined> {
  // Bun cuts a request after 10 s of silence: an app's first compile, an event stream or a long
  // poll can stay silent longer, and the page leaving ends the request anyway.
  server.timeout(request, 0);

  const url = atTarget(request.url, target);
  // The page's `Host` goes on as it came, a name of this machine the server checked: it stays in
  // step with the page's `Origin`, which apps compare, and URLs the app builds from it lead back
  // here.
  const headers = new Headers(request.headers);

  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return await relay(request, server, url, headers);
  }

  // Compression buys nothing on this machine, and Bun's `fetch` would undo it before the rewrite.
  headers.set("accept-encoding", "identity");

  try {
    const answer = asRead(
      await fetch(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        // An `HTTP_PROXY` or `ALL_PROXY` of the environment is for the internet, not this machine.
        proxy: false,
        signal: request.signal,
      }),
    );

    return request.method !== "HEAD" &&
      (answer.headers.get("content-type") ?? "").includes("text/html")
      ? withOverlay(answer, overlay)
      : answer;
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);

    return new Response(`pinpoint: the app at ${target.origin} does not answer: ${why}`, {
      status: 502,
    });
  }
}
