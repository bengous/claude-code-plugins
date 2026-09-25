import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import type { Route } from "../../../extension.ts";
import type {
  ChoiceRef,
  Decision,
  GateAnswer,
  PlanWorkspace,
  SendAnswer,
  SendRequest,
  VellumBuild,
} from "../../../protocol.ts";
import type { GateOptions, Review } from "../../app/review.ts";
import { parseProjectPath, parseVersion } from "../../domain/paths.ts";
import type { ParseResult } from "../../domain/paths.ts";
import { DRAFT_FILE } from "../../domain/workspace.ts";
import { isRecord, parseDraft, parseEdit } from "../draft.ts";

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

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser the rules ask for: it validates the JSON bodies the browser and the hooks module post, and there is no earlier place to parse them. */
async function parseDecision(request: Request): Promise<Decision | null> {
  const body: unknown = await request.json().catch(() => null);
  const edit = isRecord(body) ? parseEdit(body.edit) : null;

  return isRecord(body) &&
    edit !== null &&
    body.kind === "approve" &&
    typeof body.notes === "string"
    ? { kind: "approve", edit: edit.value, notes: body.notes }
    : null;
}

function parseIds(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((id: unknown) => typeof id === "string")
    ? value.map(String)
    : null;
}

function parseChoiceRef(value: unknown): ChoiceRef | null {
  const doc = isRecord(value) && typeof value.doc === "string" ? parseProjectPath(value.doc) : null;

  return isRecord(value) &&
    doc?.ok === true &&
    typeof value.decision === "string" &&
    value.decision !== "" &&
    typeof value.option === "string" &&
    value.option !== ""
    ? { doc: doc.value, decision: value.decision, option: value.option }
    : null;
}

function parseChoiceRefs(value: unknown): readonly ChoiceRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs = value.map((ref: unknown) => parseChoiceRef(ref));

  return refs.every((ref) => ref !== null) ? refs : null;
}

/** What a Send takes, named as the page saw it: comment ids, the edit's version or `null`, the choices, whether the parts go, the defaults agreed. */
async function parseSend(request: Request): Promise<SendRequest | null> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body) || typeof body.parts !== "boolean") return null;
  const annotations = parseIds(body.annotations);
  const choices = parseChoiceRefs(body.choices);
  const takeDefaults = parseIds(body.takeDefaults);
  const edit = typeof body.edit === "number" ? parseVersion(body.edit) : null;

  if (
    annotations === null ||
    choices === null ||
    takeDefaults === null ||
    (body.edit !== null && edit?.ok !== true)
  ) {
    return null;
  }

  return {
    annotations,
    edit: edit?.ok === true ? edit.value : null,
    choices,
    parts: body.parts,
    takeDefaults,
  };
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

function badRequest(): Response {
  return new Response("bad request", { status: 400 });
}

/** A saved draft the parser refuses was written by an older page: nothing of it is read half-way. */
export const UNREADABLE_DRAFT = `${DRAFT_FILE} was saved by an older version of vellum and cannot be read: delete it, then reload.`;

/** `GET /api/channel?after=<n>`: the number of the last entry the module relayed, 0 for none. */
function parseAfter(raw: string | null): number | null {
  const after = raw === null || raw === "" ? Number.NaN : Number(raw);

  return Number.isInteger(after) && after >= 0 ? after : null;
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

  if (route === "GET /api/channel") {
    const after = parseAfter(new URL(request.url).searchParams.get("after"));

    if (after === null) return badRequest();

    return Response.json(await review.channel(after));
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

  if (route === "POST /api/send") {
    const sending = await parseSend(request);

    if (sending === null) return badRequest();
    const sent = await review.send(sending);

    const answer: SendAnswer = sent.ok
      ? { file: sent.file, seq: sent.seq, editKept: sent.editKept }
      : sent.refusal;

    return Response.json(answer, { status: sent.ok ? 200 : 409 });
  }

  if (route === "GET /api/draft") {
    const draft = await review.draft();

    if (draft === null) return new Response(null, { status: 204 });

    return draft === "unreadable"
      ? Response.json({ error: UNREADABLE_DRAFT }, { status: 409 })
      : Response.json(draft);
  }

  if (route === "PUT /api/draft") {
    const draft = parseDraft(await request.json().catch(() => null));

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
