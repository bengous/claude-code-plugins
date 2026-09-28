import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import { reviewRoute } from "../../../review/routes.ts";
import type { ReviewServer } from "../../../review/server.ts";
import { parseProjectPath } from "../../../workshop/paths.ts";
import type { ParseResult } from "../../../workshop/paths.ts";
import type { Route } from "../../extension.ts";
import type { PlanWorkspace, VellumBuild, WorkflowAnswer } from "../../protocol.ts";
import type { Queue } from "../queue.ts";

export const TOKEN_HEADER = "x-vellum-token";

export type RouteContext = {
  readonly token: string;
  readonly project: string;
  readonly queue: Queue;
  /** The review's server half: the gate, Record, the approval, the Send, whose routes `review/routes.ts` answers. */
  readonly review: ReviewServer;
  /** `formats/html/frame.ts`, built; every HTML file served carries a tag that loads it. */
  readonly frameScript: string;
  /** The extensions' own routes, keyed as `api` keys its own: `POST /api/x/<id>/<name>`. */
  readonly extensionRoutes: ReadonlyMap<string, Route>;
  readonly openBrowser: () => void;
  readonly heartbeat: () => void;
  /** Read once at start; a failure is this route's answer, never the server's. */
  readonly vellumBuild: ParseResult<VellumBuild>;
};

/**
 * `openStreams` counts the tabs that listen. The review's own listeners cannot say: `serve.ts`
 * keeps one there for itself, so that set is never empty.
 */
export type Handler = {
  readonly handle: (request: Request) => Promise<Response>;
  readonly openStreams: () => number;
};

type Streams = { open: number };

function badRequest(): Response {
  return new Response("bad request", { status: 400 });
}

/** `GET /api/channel?after=<n>`: the number of the last entry the module relayed, 0 for none. */
function parseAfter(raw: string | null): number | null {
  const after = raw === null || raw === "" ? Number.NaN : Number(raw);

  return Number.isInteger(after) && after >= 0 ? after : null;
}

/** The tag goes before the last `</body>`, or at the end of a document without one. */
function withFrameScript(html: string, tag: string): string {
  const at = html.lastIndexOf("</body>");

  return at === -1 ? `${html}${tag}` : `${html.slice(0, at)}${tag}${html.slice(at)}`;
}

async function serveFile(project: string, rawPath: string, tag: string): Promise<Response> {
  let decoded: string;

  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return new Response("forbidden", { status: 403 });
  }

  const parsed = parseProjectPath(decoded);

  if (!parsed.ok) return new Response("forbidden", { status: 403 });
  const root = await realpath(project);
  const resolved = await realpath(join(root, parsed.value)).catch(() => null);

  if (resolved === null) return new Response("not found", { status: 404 });

  if (!resolved.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
  const file = Bun.file(resolved);

  if (!(await file.exists())) return new Response("not found", { status: 404 });

  const headers = {
    "content-type": file.type,
    "content-security-policy": "sandbox allow-scripts",
    "cache-control": "no-store",
  };

  if (!file.type.startsWith("text/html")) return new Response(file, { headers });

  return new Response(withFrameScript(await file.text(), tag), { headers });
}

function sse(queue: Queue, streams: Streams): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (workspace: PlanWorkspace): void => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "workspace", workspace })}\n\n`),
        );
      };

      streams.open += 1;
      unsubscribe = queue.subscribe(({ workspace }) => send(workspace));
      send(await queue.workspace());
    },
    cancel() {
      streams.open -= 1;
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

async function api(
  context: RouteContext,
  streams: Streams,
  request: Request,
  route: string,
): Promise<Response> {
  const { queue } = context;

  const reviewed = await reviewRoute(
    {
      queue,
      review: context.review,
      open: () => {
        if (streams.open === 0) context.openBrowser();
      },
    },
    request,
    route,
  );

  if (reviewed !== undefined) return reviewed;

  if (route === "GET /api/review") return Response.json(await queue.view());

  if (route === "GET /api/workflow") {
    // In the queue: a step writes its files before it keeps its region in memory (a proposal's
    // wait), and a read between the two would take a call's `open` wait for a paused one.
    const w = await queue.inOrder(() => queue.workflow());
    const answer: WorkflowAnswer = { workspace: w.workspace, ...queue.viewed(w) };

    return Response.json(answer);
  }

  if (route === "GET /api/channel") {
    const after = parseAfter(new URL(request.url).searchParams.get("after"));

    if (after === null) return badRequest();

    return Response.json(await queue.channel(after));
  }

  if (route === "GET /api/vellum-build") {
    const build = context.vellumBuild;

    return build.ok
      ? Response.json(build.value)
      : Response.json({ error: build.error }, { status: 500 });
  }

  if (route === "POST /api/heartbeat") {
    context.heartbeat();

    return new Response(null, { status: 204 });
  }

  if (route === "POST /api/open") {
    if (streams.open === 0) context.openBrowser();

    return new Response(null, { status: 204 });
  }

  const extensionRoute = context.extensionRoutes.get(route);

  return extensionRoute === undefined
    ? new Response("not found", { status: 404 })
    : await extensionRoute(request);
}

/** Everything but the page itself, which `Bun.serve` routes to the bundled HTML. */
export function createHandler(context: RouteContext): Handler {
  const filesPrefix = `/t/${context.token}/files/`;
  const eventsPath = `/t/${context.token}/events`;
  const framePath = `/t/${context.token}/frame.js`;
  const frameTag = `<script src="${framePath}"></script>`;
  const streams: Streams = { open: 0 };

  const handle: Handler["handle"] = async (request) => {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      if (request.headers.get(TOKEN_HEADER) !== context.token) {
        return new Response("unauthorized", { status: 401 });
      }

      return await api(context, streams, request, `${request.method} ${pathname}`);
    }

    if (request.method === "GET" && pathname === framePath) {
      return new Response(context.frameScript, {
        headers: { "content-type": "text/javascript", "cache-control": "no-store" },
      });
    }

    if (request.method === "GET" && pathname.startsWith(filesPrefix)) {
      return await serveFile(context.project, pathname.slice(filesPrefix.length), frameTag);
    }

    if (request.method === "GET" && pathname === eventsPath) return sse(context.queue, streams);

    return new Response("not found", { status: 404 });
  };

  return { handle, openStreams: () => streams.open };
}
