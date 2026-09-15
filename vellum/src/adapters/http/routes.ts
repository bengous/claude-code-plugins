import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import type { Review } from "../../app/review.ts";
import { parseProjectPath, parseVersion } from "../../domain/paths.ts";
import type { Anchor, Annotation, Decision, GateInput, PlanWorkspace } from "../../protocol.ts";

export const TOKEN_HEADER = "x-vellum-token";

export type RouteContext = {
  readonly token: string;
  readonly project: string;
  readonly review: Review;
  readonly openBrowser: () => void;
  readonly heartbeat: () => void;
};

type Handler = (request: Request) => Promise<Response>;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser the rules ask for: it validates the JSON bodies the browser and the hooks module post, and there is no earlier place to parse them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function parseGate(request: Request): Promise<GateInput | null> {
  const body: unknown = await request.json().catch(() => null);

  return isRecord(body) && typeof body.plan === "string" && typeof body.planFilePath === "string"
    ? { plan: body.plan, planFilePath: body.planFilePath }
    : null;
}

function parseAnchor(value: unknown): Anchor | null {
  if (!isRecord(value)) return null;

  if (value.kind === "global") return { kind: "global" };

  if (
    value.kind === "text" &&
    typeof value.quote === "string" &&
    typeof value.prefix === "string" &&
    typeof value.suffix === "string" &&
    Array.isArray(value.lines) &&
    typeof value.lines[0] === "number" &&
    typeof value.lines[1] === "number"
  ) {
    return {
      kind: "text",
      quote: value.quote,
      prefix: value.prefix,
      suffix: value.suffix,
      lines: [value.lines[0], value.lines[1]],
    };
  }

  return null;
}

function parseAnnotation(value: unknown): Annotation | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.body !== "string") {
    return null;
  }

  const doc = typeof value.doc === "string" ? parseProjectPath(value.doc) : null;
  const anchor = parseAnchor(value.anchor);

  return doc?.ok === true && anchor !== null
    ? { id: value.id, doc: doc.value, anchor, body: value.body }
    : null;
}

async function parseDecision(request: Request): Promise<Decision | null> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) return null;

  if (body.kind === "approve") return { kind: "approve" };

  if (body.kind !== "feedback" || !Array.isArray(body.annotations)) return null;
  const annotations = body.annotations.map(parseAnnotation);

  return annotations.every((annotation) => annotation !== null)
    ? { kind: "feedback", annotations }
    : null;
}

async function parseFinalize(request: Request): Promise<number | null> {
  const body: unknown = await request.json().catch(() => null);

  return isRecord(body) && typeof body.version === "number" ? body.version : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

function badRequest(): Response {
  return new Response("bad request", { status: 400 });
}

async function serveFile(project: string, rawPath: string): Promise<Response> {
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

  return new Response(file, {
    headers: {
      "content-type": file.type,
      "content-security-policy": "sandbox allow-scripts",
      "cache-control": "no-store",
    },
  });
}

function sse(review: Review): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (workspace: PlanWorkspace): void => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "workspace", workspace })}\n\n`),
        );
      };

      unsubscribe = review.subscribe(send);
      send(await review.workspace());
    },
    cancel() {
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

async function api(context: RouteContext, request: Request, route: string): Promise<Response> {
  const { review } = context;

  if (route === "GET /api/review") return Response.json(await review.view());

  if (route === "GET /api/pending") return Response.json(await review.pending());

  if (route === "POST /api/heartbeat") {
    context.heartbeat();

    return new Response(null, { status: 204 });
  }

  if (route === "POST /api/open") {
    context.openBrowser();

    return new Response(null, { status: 204 });
  }

  if (route === "POST /api/gate") {
    const input = await parseGate(request);

    if (input === null) return badRequest();
    const version = await review.gate(input);

    if (review.listenerCount === 0) context.openBrowser();

    return Response.json({ version });
  }

  if (route === "POST /api/decision") {
    const decision = await parseDecision(request);

    if (decision === null) return badRequest();
    const result = await review.decide(decision);

    return Response.json({ workspace: result.workspace }, { status: result.ok ? 200 : 409 });
  }

  if (route === "POST /api/finalize") {
    const raw = await parseFinalize(request);
    const version = raw === null ? null : parseVersion(raw);

    if (version?.ok !== true) return badRequest();
    const result = await review.finalize(version.value);

    return result.ok
      ? Response.json({ workspace: result.workspace, plan: result.plan })
      : Response.json({ workspace: result.workspace }, { status: 409 });
  }

  return new Response("not found", { status: 404 });
}

/** Everything but the page itself, which `Bun.serve` routes to the bundled HTML. */
export function createHandler(context: RouteContext): Handler {
  const filesPrefix = `/t/${context.token}/files/`;
  const eventsPath = `/t/${context.token}/events`;

  return async (request) => {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      if (request.headers.get(TOKEN_HEADER) !== context.token) {
        return new Response("unauthorized", { status: 401 });
      }

      return await api(context, request, `${request.method} ${pathname}`);
    }

    if (request.method === "GET" && pathname.startsWith(filesPrefix)) {
      return await serveFile(context.project, pathname.slice(filesPrefix.length));
    }

    if (request.method === "GET" && pathname === eventsPath) return sse(context.review);

    return new Response("not found", { status: 404 });
  };
}
