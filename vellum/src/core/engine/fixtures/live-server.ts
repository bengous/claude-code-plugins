import type { HttpResponse, On } from "claude-code";

import { reply } from "./reply.ts";
import { SERVER } from "./server.ts";

/** What a route answers to a request's body and query; `null` is a server that does not answer that call. */
export type Route = (
  body: string | undefined,
  query: URLSearchParams,
) => HttpResponse | null | Promise<HttpResponse | null>;

const LIVE = {
  "/api/review": () => reply(200, { workspace: { kind: "drafting" } }),
  "/api/heartbeat": () => reply(204, null),
  "/api/gate": () => reply(200, { version: 1, kept: false }),
  "/api/pending": () => reply(200, { kind: "none" }),
  "/api/open": () => reply(204, null),
} satisfies Record<string, Route>;

/** Where the extensions' routes live. The core's world serves none: each extension's fixtures bring its own. */
const EXTENSIONS = "/api/x/";

export function liveServer(on: On, routes: Record<string, Route> = {}): string[] {
  const paths: string[] = [];
  const served = new Map([...Object.entries(LIVE), ...Object.entries(routes)]);

  on("http.fetch", async (_, e) => {
    const { pathname, port, searchParams } = new URL(e.url);

    // A live server answers 404 there, and `paths` stays what the core itself asked.
    if (pathname.startsWith(EXTENSIONS) && !served.has(pathname) && Number(port) === SERVER.port) {
      return { value: reply(404, null) };
    }

    paths.push(pathname);

    const answer =
      Number(port) === SERVER.port
        ? ((await served.get(pathname)?.(e.init?.body, searchParams)) ?? null)
        : null;

    return answer === null ? { deny: `ECONNREFUSED ${e.url}` } : { value: answer };
  });

  return paths;
}
