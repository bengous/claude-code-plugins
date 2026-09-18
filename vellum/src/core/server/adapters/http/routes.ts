import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import type { Route } from "../../../extension.ts";
import type {
  Anchor,
  Annotation,
  Decision,
  Draft,
  Edit,
  ElementRef,
  GateAnswer,
  Mark,
  Passage,
  PlanWorkspace,
} from "../../../protocol.ts";
import type { GateOptions, Review } from "../../app/review.ts";
import { isQuickLabel } from "../../domain/feedback.ts";
import { parseProjectPath, parseVersion } from "../../domain/paths.ts";

export const TOKEN_HEADER = "x-vellum-token";

export type RouteContext = {
  readonly token: string;
  readonly project: string;
  readonly review: Review;
  /** `extensions/html/frame.ts`, built; every HTML file served carries a tag that loads it. */
  readonly frameScript: string;
  /** The extensions' own routes, keyed as `api` keys its own: `POST /api/x/<id>/<name>`. */
  readonly extensionRoutes: ReadonlyMap<string, Route>;
  readonly openBrowser: () => void;
  readonly heartbeat: () => void;
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

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser the rules ask for: it validates the JSON bodies the browser and the hooks module post, and there is no earlier place to parse them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAnchor(value: unknown): Anchor | null {
  if (!isRecord(value)) return null;

  if (value.kind === "global") return { kind: "global" };

  if (value.kind === "element") {
    if (!Array.isArray(value.elements)) return null;
    const elements = value.elements.map(parseElementRef);

    if (elements.some((element) => element === null)) return null;
    const [head, ...tail] = elements.filter((element) => element !== null);

    return head === undefined ? null : { kind: "element", elements: [head, ...tail] };
  }

  if (value.kind !== "text" || !Array.isArray(value.passages)) return null;
  const parsed = value.passages.map(parsePassage);

  if (parsed.some((passage) => passage === null)) return null;
  const [first, ...rest] = parsed.filter((passage) => passage !== null);

  return first === undefined ? null : { kind: "text", passages: [first, ...rest] };
}

function parseElementRef(value: unknown): ElementRef | null {
  if (
    !isRecord(value) ||
    typeof value.selector !== "string" ||
    value.selector === "" ||
    typeof value.text !== "string" ||
    typeof value.label !== "string"
  ) {
    return null;
  }

  return { selector: value.selector, text: value.text, label: value.label };
}

function parsePassage(value: unknown): Passage | null {
  if (
    !isRecord(value) ||
    typeof value.quote !== "string" ||
    typeof value.prefix !== "string" ||
    typeof value.suffix !== "string" ||
    !Array.isArray(value.lines) ||
    typeof value.lines[0] !== "number" ||
    typeof value.lines[1] !== "number"
  ) {
    return null;
  }

  return {
    quote: value.quote,
    prefix: value.prefix,
    suffix: value.suffix,
    lines: [value.lines[0], value.lines[1]],
  };
}

function parseMark(value: unknown): Mark | null {
  if (!isRecord(value)) return null;

  if (value.kind === "delete") return { kind: "delete" };

  if (typeof value.body !== "string") return null;

  if (value.kind === "comment") return { kind: "comment", body: value.body };

  return value.kind === "label" && typeof value.label === "string" && isQuickLabel(value.label)
    ? { kind: "label", label: value.label, body: value.body }
    : null;
}

function parseAnnotation(value: unknown): Annotation | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const doc = typeof value.doc === "string" ? parseProjectPath(value.doc) : null;
  const anchor = parseAnchor(value.anchor);
  const mark = parseMark(value.mark);

  if (doc?.ok !== true || anchor === null || mark === null) return null;

  // "Delete this" needs a place to delete: the document as a whole is not one.
  return mark.kind === "delete" && anchor.kind === "global"
    ? null
    : { id: value.id, doc: doc.value, anchor, mark };
}

function parseAnnotations(value: unknown): readonly Annotation[] | null {
  if (!Array.isArray(value)) return null;
  const annotations = value.map((annotation: unknown) => parseAnnotation(annotation));

  return annotations.every((annotation) => annotation !== null) ? annotations : null;
}

/** `null` is a decision without an edit, so a refusal is no `null`: the parsed edit comes wrapped. */
function parseEdit(value: unknown): { readonly value: Edit | null } | null {
  if (value === null) return { value: null };

  if (!isRecord(value) || typeof value.version !== "number" || typeof value.text !== "string") {
    return null;
  }

  const version = parseVersion(value.version);

  return version.ok ? { value: { version: version.value, text: value.text } } : null;
}

async function parseDecision(request: Request): Promise<Decision | null> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) return null;

  const edit = parseEdit(body.edit);

  if (edit === null) return null;

  if (body.kind === "approve") {
    return typeof body.notes === "string"
      ? { kind: "approve", edit: edit.value, notes: body.notes }
      : null;
  }

  const annotations = body.kind === "feedback" ? parseAnnotations(body.annotations) : null;

  return annotations === null ? null : { kind: "feedback", edit: edit.value, annotations };
}

/** The same annotations and the same edit a decision carries, so a restored draft can be sent as it is. */
async function parseDraft(request: Request): Promise<Draft | null> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) return null;
  const annotations = parseAnnotations(body.annotations);
  const edit = parseEdit(body.edit);

  return annotations === null || edit === null ? null : { annotations, edit: edit.value };
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

function badRequest(): Response {
  return new Response("bad request", { status: 400 });
}

async function parseGateOptions(request: Request): Promise<GateOptions> {
  const body: unknown = await request.json().catch(() => null);

  return isRecord(body) && body.unchanged === "keep"
    ? { unchanged: "keep" }
    : { unchanged: "record" };
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

function sse(review: Review, streams: Streams): Response {
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
      unsubscribe = review.subscribe(send);
      send(await review.workspace());
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
  const { review } = context;

  if (route === "GET /api/review") return Response.json(await review.view());

  if (route === "GET /api/pending") return Response.json(await review.pending());

  if (route === "POST /api/heartbeat") {
    context.heartbeat();

    return new Response(null, { status: 204 });
  }

  if (route === "POST /api/open") {
    if (streams.open === 0) context.openBrowser();

    return new Response(null, { status: 204 });
  }

  if (route === "POST /api/gate") {
    const gated = await review.gate(await parseGateOptions(request));

    if (!gated.ok) {
      const refused: GateAnswer = { error: gated.error };

      return Response.json(refused, { status: 409 });
    }

    if (streams.open === 0) context.openBrowser();
    const answer: GateAnswer = { version: gated.version, kept: gated.kept };

    return Response.json(answer);
  }

  if (route === "POST /api/decision") {
    const decision = await parseDecision(request);

    if (decision === null) return badRequest();
    const result = await review.decide(decision);

    return Response.json({ workspace: result.workspace }, { status: result.ok ? 200 : 409 });
  }

  if (route === "GET /api/draft") {
    const draft = await review.draft();

    return draft === null
      ? new Response(null, { status: 204 })
      : new Response(draft, { headers: { "content-type": "application/json" } });
  }

  if (route === "PUT /api/draft") {
    const draft = await parseDraft(request);

    if (draft === null) return badRequest();

    return new Response(null, { status: (await review.saveDraft(draft)) ? 204 : 409 });
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

    if (request.method === "GET" && pathname === eventsPath) return sse(context.review, streams);

    return new Response("not found", { status: 404 });
  };

  return { handle, openStreams: () => streams.open };
}
