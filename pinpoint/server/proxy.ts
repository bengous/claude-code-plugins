/**
 * The target app, served through the session's server: its pages come with the overlay, every
 * other answer passes as the app gave it, and its WebSockets (Vite's hot reload among them) are
 * relayed both ways. Requests only ever go to the target's origin.
 */

type Page = Bun.ServerWebSocket<Relay>;

/** A page's WebSocket: the app's side, open before the page's, and what the page hears once it opens. */
export type Relay = {
  readonly app: WebSocket;
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

/** The request's path and query on the target, set apart so a path such as `//elsewhere/` stays a path. */
function atTarget(requestUrl: string, target: URL): URL {
  const { pathname, search } = new URL(requestUrl);
  const url = new URL(target.origin);
  url.pathname = pathname;
  url.search = search;

  return url;
}

function withOverlay(page: Response, overlay: string): Response {
  const headers = new Headers(page.headers);
  // The app's validators name the body without the tag: a page revalidated against them comes back
  // from the browser's cache with the tag it was stored with, the token of an earlier server.
  headers.delete("etag");
  headers.delete("last-modified");

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
  // @ts-expect-error -- Bun's client takes options, headers among them; the `DOM` lib types subprotocols only.
  const app: WebSocket = new WebSocket(url, options);
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

/** The page's side of each relay: its messages and its end go to the app. */
export const relays: Bun.WebSocketHandler<Relay> = {
  open: (page) => {
    page.data.opened(page);
  },
  message: (page, message) => {
    page.data.app.send(message);
  },
  close: (page) => {
    page.data.app.close();
  },
};

/**
 * Sends `request` on to `target`. A page comes back with `<script src="<overlay>" defer>` at the
 * end of its body; every other answer, a redirect included, passes as the app gave it.
 */
export async function forward(
  request: Request,
  server: Bun.Server<Relay>,
  target: URL,
  overlay: string,
): Promise<Response | undefined> {
  const url = atTarget(request.url, target);
  const headers = new Headers(request.headers);
  headers.set("host", url.host);

  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return await relay(request, server, url, headers);
  }

  // Bun's `fetch` decompresses the body it reads yet keeps the app's `content-encoding`, and asks
  // for compression unless told otherwise: the browser would fail to read any answer compressed.
  headers.set("accept-encoding", "identity");

  try {
    const answer = await fetch(url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });

    return (answer.headers.get("content-type") ?? "").includes("text/html")
      ? withOverlay(answer, overlay)
      : answer;
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);

    return new Response(`pinpoint: the app at ${target.origin} does not answer: ${why}`, {
      status: 502,
    });
  }
}
